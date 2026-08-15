import {
  EditorSelection,
  type ChangeSet,
  type EditorState,
  StateEffect,
  StateField,
  type Extension,
  type StateCommand
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

export interface CmSnippetTabstop {
  number: number;
  from: number;
  to: number;
  final: boolean;
}

export interface ParsedCmSnippet {
  text: string;
  tabstops: CmSnippetTabstop[];
}

interface PlaceholderToken {
  end: number;
  number: number | null;
  start: number;
  defaultText: string;
}

/**
 * A snippet node owns its own tabstop sequence.  A child is a snippet
 * inserted into one of the parent's editable fields.  Keeping the hierarchy
 * in the state is what lets Tab leave an inner snippet and resume the outer
 * one instead of replacing the outer tabstops.
 */
interface CmSnippetNode {
  /** Absolute insertion position, used only to keep siblings in source order. */
  anchorFrom: number | null;
  children: CmSnippetNode[];
  /** The field number in the parent that contains this node. */
  hostFieldNumber: number | null;
  id: number;
  activeNumber: number;
  tabstops: CmSnippetTabstop[];
}

interface ActiveCmSnippet {
  kind: "active";
  activeNodeId: number;
  root: CmSnippetNode;
}

interface FinishedCmSnippet {
  kind: "finished";
  position: number;
}

export type CmSnippetState = ActiveCmSnippet | FinishedCmSnippet;

function unescapePlaceholderText(value: string) {
  return value.replace(/\\([{}])/g, "$1");
}

function readPlaceholder(template: string, start: number): PlaceholderToken | null {
  if (template[start] !== "$") {
    return null;
  }

  const simpleMatch = /^\$(\d+)/.exec(template.slice(start));
  if (simpleMatch) {
    return {
      defaultText: "",
      end: start + simpleMatch[0].length,
      number: Number(simpleMatch[1]),
      start
    };
  }

  const bracedMatch = /^\$\{((?:\\[{}]|[^{}])*)\}/.exec(template.slice(start));
  if (!bracedMatch) {
    return null;
  }

  const content = bracedMatch[1];
  const colonIndex = content.indexOf(":");
  const numberText = colonIndex === -1 ? content : content.slice(0, colonIndex);
  if (numberText && !/^\d+$/.test(numberText)) {
    return null;
  }

  return {
    defaultText: unescapePlaceholderText(colonIndex === -1 ? "" : content.slice(colonIndex + 1)),
    end: start + bracedMatch[0].length,
    number: numberText ? Number(numberText) : null,
    start
  };
}

function collectPlaceholderTokens(template: string) {
  const tokens: PlaceholderToken[] = [];
  for (let index = 0; index < template.length; index += 1) {
    const token = readPlaceholder(template, index);
    if (!token) {
      continue;
    }
    tokens.push(token);
    index = token.end - 1;
  }
  return tokens;
}

/**
 * Parse the VS Code/Monaco-style numeric snippet syntax into plain text and
 * zero-width or default-text tabstop ranges. Placeholder markers themselves
 * never reach the document.
 */
export function parseCmSnippetTemplate(template: string): ParsedCmSnippet {
  const tokens = collectPlaceholderTokens(template);
  const explicitNumbers = new Set(
    tokens
      .map((token) => token.number)
      .filter((number): number is number => number !== null)
  );
  let nextImplicitNumber = 1;
  const resolvedNumbers = tokens.map((token) => {
    if (token.number !== null) {
      return token.number;
    }
    while (explicitNumbers.has(nextImplicitNumber)) {
      nextImplicitNumber += 1;
    }
    const number = nextImplicitNumber;
    explicitNumbers.add(number);
    nextImplicitNumber += 1;
    return number;
  });

  const defaults = new Map<number, string>();
  tokens.forEach((token, index) => {
    const number = resolvedNumbers[index];
    if (number !== 0 && !defaults.has(number) && token.defaultText.length > 0) {
      defaults.set(number, token.defaultText);
    }
  });

  const tabstops: CmSnippetTabstop[] = [];
  let text = "";
  let sourceOffset = 0;
  tokens.forEach((token, index) => {
    text += template.slice(sourceOffset, token.start);
    const number = resolvedNumbers[index];
    const from = text.length;
    if (number !== 0) {
      text += defaults.get(number) ?? "";
    }
    tabstops.push({
      final: number === 0,
      from,
      number,
      to: text.length
    });
    sourceOffset = token.end;
  });
  text += template.slice(sourceOffset);

  return { tabstops, text };
}

function uniqueTabstopNumbers(tabstops: CmSnippetTabstop[]) {
  return [...new Set(tabstops.map((tabstop) => tabstop.number))].sort((left, right) => {
    if (left === 0) return 1;
    if (right === 0) return -1;
    return left - right;
  });
}

function tabstopRanges(tabstops: CmSnippetTabstop[], number: number) {
  return tabstops.filter((tabstop) => tabstop.number === number);
}

function selectionForTabstop(tabstops: CmSnippetTabstop[], number: number) {
  return EditorSelection.create(
    tabstopRanges(tabstops, number).map((tabstop) =>
      EditorSelection.range(tabstop.from, tabstop.to)
    )
  );
}

function mapTabstop(tabstop: CmSnippetTabstop, changes: ChangeSet): CmSnippetTabstop {
  return {
    ...tabstop,
    from: changes.mapPos(tabstop.from, -1),
    to: changes.mapPos(tabstop.to, 1)
  };
}

function mapSnippetNode(node: CmSnippetNode, changes: ChangeSet): CmSnippetNode {
  return {
    ...node,
    anchorFrom: node.anchorFrom === null ? null : changes.mapPos(node.anchorFrom, 1),
    children: node.children.map((child) => mapSnippetNode(child, changes)),
    tabstops: node.tabstops.map((tabstop) => mapTabstop(tabstop, changes))
  };
}

function compareChildren(left: CmSnippetNode, right: CmSnippetNode): number {
  const leftField = left.hostFieldNumber ?? Number.MAX_SAFE_INTEGER;
  const rightField = right.hostFieldNumber ?? Number.MAX_SAFE_INTEGER;
  if (leftField !== rightField) {
    return leftField - rightField;
  }
  return (left.anchorFrom ?? 0) - (right.anchorFrom ?? 0);
}

function appendSnippetChild(
  node: CmSnippetNode,
  hostNodeId: number,
  child: CmSnippetNode
): CmSnippetNode {
  if (node.id === hostNodeId) {
    return {
      ...node,
      children: [...node.children, child].sort(compareChildren)
    };
  }
  return {
    ...node,
    children: node.children.map((nested) =>
      appendSnippetChild(nested, hostNodeId, child)
    )
  };
}

function removeSnippetNode(node: CmSnippetNode, nodeId: number): CmSnippetNode {
  return {
    ...node,
    children: node.children
      .filter((child) => child.id !== nodeId)
      .map((child) => removeSnippetNode(child, nodeId))
  };
}

function setNodeActiveNumber(
  node: CmSnippetNode,
  nodeId: number,
  number: number
): CmSnippetNode {
  return {
    ...node,
    activeNumber: node.id === nodeId ? number : node.activeNumber,
    children: node.children.map((child) =>
      setNodeActiveNumber(child, nodeId, number)
    )
  };
}

function findSnippetNode(node: CmSnippetNode, nodeId: number): CmSnippetNode | null {
  if (node.id === nodeId) {
    return node;
  }
  for (const child of node.children) {
    const found = findSnippetNode(child, nodeId);
    if (found) {
      return found;
    }
  }
  return null;
}

interface SnippetNodeContext {
  index: number;
  node: CmSnippetNode;
  parent: CmSnippetNode | null;
}

function findSnippetNodeContext(
  node: CmSnippetNode,
  nodeId: number,
  parent: CmSnippetNode | null = null
): SnippetNodeContext | null {
  if (node.id === nodeId) {
    const index = parent ? parent.children.findIndex((child) => child.id === nodeId) : -1;
    return { index, node, parent };
  }
  for (const child of node.children) {
    const found = findSnippetNodeContext(child, nodeId, node);
    if (found) {
      return found;
    }
  }
  return null;
}

interface LocatedSnippetField {
  depth: number;
  node: CmSnippetNode;
  number: number;
}

function selectionFitsTabstopNumber(
  selection: EditorSelection,
  tabstops: CmSnippetTabstop[],
  number: number
) {
  const ranges = tabstopRanges(tabstops, number);
  return ranges.length > 0 && selection.ranges.every((selectionRange) =>
    ranges.some(
      (tabstop) =>
        tabstop.from <= selectionRange.from && tabstop.to >= selectionRange.to
    )
  );
}

/**
 * Locate the deepest snippet field containing the current selection.  The
 * preferred node/number resolves the ambiguous zero-width `$1$0` boundary
 * after a command explicitly moved to `$0`.
 */
function findDeepestSnippetField(
  root: CmSnippetNode,
  selection: EditorSelection,
  preferredNodeId?: number,
  preferredNumber?: number
): LocatedSnippetField | null {
  let best: LocatedSnippetField | null = null;

  const visit = (node: CmSnippetNode, depth: number) => {
    const numbers = uniqueTabstopNumbers(node.tabstops);
    const orderedNumbers = [
      ...(node.id === preferredNodeId && preferredNumber !== undefined
        ? [preferredNumber]
        : []),
      ...numbers.filter(
        (number) => !(node.id === preferredNodeId && number === preferredNumber)
      )
    ];
    for (const number of orderedNumbers) {
      if (!selectionFitsTabstopNumber(selection, node.tabstops, number)) {
        continue;
      }
      if (!best || depth >= best.depth) {
        best = { depth, node, number };
      }
      break;
    }
    for (const child of node.children) {
      visit(child, depth + 1);
    }
  };

  visit(root, 0);
  return best;
}

function childForField(node: CmSnippetNode, number: number): CmSnippetNode | null {
  return node.children.find((child) => child.hostFieldNumber === number) ?? null;
}

let nextSnippetNodeId = 1;

function createSnippetNode(
  tabstops: CmSnippetTabstop[],
  activeNumber: number,
  anchorFrom: number | null,
  hostFieldNumber: number | null
): CmSnippetNode {
  return {
    anchorFrom,
    children: [],
    hostFieldNumber,
    id: nextSnippetNodeId++,
    activeNumber,
    tabstops
  };
}

const startCmSnippet = StateEffect.define<ActiveCmSnippet>();
const setActiveCmSnippet = StateEffect.define<{ nodeId: number; number: number }>();
const insertNestedCmSnippet = StateEffect.define<{
  hostFieldNumber: number;
  hostNodeId: number;
  node: CmSnippetNode;
}>();
const finishCmSnippet = StateEffect.define<number>();
const clearCmSnippetEffect = StateEffect.define<void>();

class CmSnippetFieldMarker extends WidgetType {
  constructor(private readonly active: boolean) {
    super();
  }

  eq(other: CmSnippetFieldMarker) {
    return this.active === other.active;
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = this.active
      ? "cm-snippetFieldPosition cm-snippetFieldPosition-active"
      : "cm-snippetFieldPosition cm-snippetFieldPosition-inactive";
    // This is decoration-only: it creates a visible one-character field for
    // an empty tabstop without putting whitespace into the document. Once
    // the user types, the mapped tabstop becomes a normal text range and the
    // marker disappears automatically.
    element.textContent = "\u00a0";
    return element;
  }

  ignoreEvent() {
    return false;
  }
}

const activeEmptyFieldMarker = Decoration.widget({ widget: new CmSnippetFieldMarker(true) });
const inactiveEmptyFieldMarker = Decoration.widget({ widget: new CmSnippetFieldMarker(false) });
const inactiveFieldMark = Decoration.mark({ class: "cm-snippetField cm-snippetField-inactive" });
const activeFieldMark = Decoration.mark({ class: "cm-snippetField cm-snippetField-active" });

function buildSnippetDecorations(state: CmSnippetState) {
  if (state.kind !== "active") {
    return Decoration.none;
  }

  const decorations = [] as Array<ReturnType<typeof inactiveFieldMark.range>>;
  const visit = (node: CmSnippetNode) => {
    for (const tabstop of node.tabstops) {
      if (tabstop.final) {
        continue;
      }
      const active =
        node.id === state.activeNodeId && tabstop.number === node.activeNumber;
      if (tabstop.from === tabstop.to) {
        decorations.push(
          (active ? activeEmptyFieldMarker : inactiveEmptyFieldMarker).range(tabstop.from)
        );
      } else {
        decorations.push(
          (active ? activeFieldMark : inactiveFieldMark).range(tabstop.from, tabstop.to)
        );
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(state.root);
  return Decoration.set(decorations, true);
}

export const cmSnippetState = StateField.define<CmSnippetState | null>({
  create: () => null,
  update(value, transaction) {
    let next = value;
    let started = false;
    let nestedInsertion: {
      hostFieldNumber: number;
      hostNodeId: number;
      node: CmSnippetNode;
    } | null = null;

    for (const effect of transaction.effects) {
      if (effect.is(startCmSnippet)) {
        next = effect.value;
        started = true;
      } else if (effect.is(setActiveCmSnippet) && next?.kind === "active") {
        next = {
          ...next,
          activeNodeId: effect.value.nodeId,
          root: setNodeActiveNumber(next.root, effect.value.nodeId, effect.value.number)
        };
      } else if (effect.is(insertNestedCmSnippet)) {
        nestedInsertion = effect.value;
      } else if (effect.is(finishCmSnippet)) {
        next = { kind: "finished", position: effect.value };
      } else if (effect.is(clearCmSnippetEffect)) {
        next = null;
      }
    }

    if (!next) {
      return null;
    }

    if (next.kind === "active" && transaction.docChanged && !started) {
      next = { ...next, root: mapSnippetNode(next.root, transaction.changes) };
    }

    if (next.kind === "active" && nestedInsertion) {
      next = {
        ...next,
        activeNodeId: nestedInsertion.node.id,
        root: appendSnippetChild(next.root, nestedInsertion.hostNodeId, nestedInsertion.node)
      };
    }

    if (next.kind === "finished") {
      if (transaction.docChanged) {
        return null;
      }
      if (transaction.selection && !selectionAtPosition(transaction.selection, next.position)) {
        return null;
      }
      return next;
    }

    if (transaction.selection) {
      const located = findDeepestSnippetField(
        next.root,
        transaction.selection,
        next.activeNodeId,
        findSnippetNode(next.root, next.activeNodeId)?.activeNumber
      );
      if (!located) {
        return null;
      }
      next = {
        ...next,
        activeNodeId: located.node.id,
        root: setNodeActiveNumber(next.root, located.node.id, located.number)
      };
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) =>
      value ? buildSnippetDecorations(value) : Decoration.none
    )
});

function selectionAtPosition(selection: EditorSelection, position: number) {
  return selection.ranges.every((range) => range.from === position && range.to === position);
}

export const cmSnippetTheme: Extension = EditorView.baseTheme({
  ".cm-snippetField": {
    backgroundColor: "color-mix(in srgb, var(--wb-info-bg) 34%, transparent)",
    borderBottom: "1px dotted color-mix(in srgb, var(--wb-accent) 70%, transparent)"
  },
  ".cm-snippetField.cm-snippetField-active": {
    backgroundColor: "color-mix(in srgb, var(--wb-accent) 18%, transparent)",
    borderBottom: "2px solid var(--wb-accent-strong)"
  },
  ".cm-snippetFieldPosition": {
    display: "inline-block",
    minWidth: "1ch",
    height: "1.05em",
    marginInline: "0.04em",
    verticalAlign: "-0.12em",
    borderBottom: "1px dotted color-mix(in srgb, var(--wb-accent) 70%, transparent)"
  },
  ".cm-snippetFieldPosition-active": {
    backgroundColor: "color-mix(in srgb, var(--wb-accent) 18%, transparent)",
    borderBottom: "2px solid var(--wb-accent-strong)"
  },
  ".cm-snippetFieldPosition-inactive": {
    backgroundColor: "transparent"
  }
});

export const cmSnippetExtension: Extension = [cmSnippetState, cmSnippetTheme];

export function getCmSnippetState(state: EditorState) {
  return state.field(cmSnippetState, false);
}

export function isCmSnippetActive(state: EditorState) {
  return getCmSnippetState(state)?.kind === "active";
}

function makeActiveState(root: CmSnippetNode, activeNodeId: number): ActiveCmSnippet {
  return { kind: "active", activeNodeId, root };
}

export function insertCmSnippet(view: EditorView, template: string, from?: number, to?: number) {
  const parsed = parseCmSnippetTemplate(template);
  const currentSelection = view.state.selection.main;
  const changeFrom = from ?? currentSelection.from;
  const changeTo = to ?? currentSelection.to;
  const postInsertionTabstops = parsed.tabstops.map((tabstop) => ({
    ...tabstop,
    from: changeFrom + tabstop.from,
    to: changeFrom + tabstop.to
  }));
  const numbers = uniqueTabstopNumbers(postInsertionTabstops);
  const firstNumber = numbers.find((number) => number !== 0);
  const selection = firstNumber === undefined
    ? postInsertionTabstops.some((tabstop) => tabstop.final)
      ? selectionForTabstop(postInsertionTabstops, 0)
      : EditorSelection.cursor(changeFrom + parsed.text.length)
    : selectionForTabstop(postInsertionTabstops, firstNumber);

  const currentSnippet = getCmSnippetState(view.state);
  const host = currentSnippet?.kind === "active"
    ? findDeepestSnippetField(currentSnippet.root, view.state.selection)
    : null;
  const hostNode =
    host && host.number !== 0 && currentSnippet?.kind === "active"
      ? findSnippetNode(currentSnippet.root, host.node.id)
      : null;
  const node = firstNumber === undefined
    ? null
    : createSnippetNode(
        postInsertionTabstops,
        firstNumber,
        changeFrom,
        hostNode ? host?.number ?? null : null
      );

  let effects: StateEffect<unknown> | StateEffect<unknown>[];
  if (hostNode && node && currentSnippet?.kind === "active") {
    effects = insertNestedCmSnippet.of({
      hostFieldNumber: host?.number ?? hostNode.activeNumber,
      hostNodeId: hostNode.id,
      node
    });
  } else if (node) {
    effects = startCmSnippet.of(makeActiveState(node, node.id));
  } else if (!hostNode) {
    effects = clearCmSnippetEffect.of(undefined);
  } else {
    // A completion-only command with no tabstops still belongs to the active
    // outer field.  The document change maps the existing tree and no child
    // node needs to be created.
    effects = [];
  }

  view.dispatch({
    // A string lets CodeMirror split embedded line breaks into real document
    // lines. `Text.of([parsed.text])` treats the whole string as one Text line,
    // which makes multi-line snippets render as one line and invalidates the
    // visual position of their tabstops.
    changes: { from: changeFrom, insert: parsed.text, to: changeTo },
    effects,
    selection,
    scrollIntoView: true
  });
}

function dispatchActiveSelection(
  dispatch: (transaction: ReturnType<EditorState["update"]>) => void,
  state: EditorState,
  root: CmSnippetNode,
  node: CmSnippetNode,
  number: number
) {
  dispatch(
    state.update({
      effects: startCmSnippet.of(makeActiveState(root, node.id)),
      scrollIntoView: true,
      selection: selectionForTabstop(node.tabstops, number)
    })
  );
}

function nextNumberAfter(node: CmSnippetNode, currentNumber: number): number | undefined {
  const numbers = uniqueTabstopNumbers(node.tabstops);
  const index = numbers.indexOf(currentNumber);
  return index < 0 ? numbers[0] : numbers[index + 1];
}

/**
 * `$0` is a completion boundary, not an editable field.  As soon as Tab
 * moves to it, discard that node so Shift-Tab cannot reopen fields that the
 * user has already confirmed.  For a nested node, retain the parent tree and
 * keep the caret at the final position inside the parent's host field.
 */
function destroyNodeAtFinalTabstop(
  state: EditorState,
  active: ActiveCmSnippet,
  node: CmSnippetNode,
  dispatch: (transaction: ReturnType<EditorState["update"]>) => void
): boolean {
  const context = findSnippetNodeContext(active.root, node.id);
  if (!context) {
    return false;
  }

  const finalSelection = selectionForTabstop(node.tabstops, 0);
  if (!context.parent) {
    dispatch(
      state.update({
        effects: clearCmSnippetEffect.of(undefined),
        scrollIntoView: true,
        selection: finalSelection
      })
    );
    return true;
  }

  const rootAfterRemoval = removeSnippetNode(active.root, node.id);
  const parent = findSnippetNode(rootAfterRemoval, context.parent.id);
  if (!parent) {
    return false;
  }

  dispatch(
    state.update({
      effects: startCmSnippet.of(makeActiveState(rootAfterRemoval, parent.id)),
      scrollIntoView: true,
      selection: finalSelection
    })
  );
  return true;
}

function completeNodeAndFindSuccessor(
  state: EditorState,
  active: ActiveCmSnippet,
  node: CmSnippetNode,
  dispatch: (transaction: ReturnType<EditorState["update"]>) => void
): boolean {
  const context = findSnippetNodeContext(active.root, node.id);
  if (!context) {
    return false;
  }

  const position = state.selection.main.to;
  if (!context.parent) {
    dispatch(
      state.update({
        effects: finishCmSnippet.of(position),
        scrollIntoView: true,
        selection: EditorSelection.cursor(position)
      })
    );
    return true;
  }

  const parentBeforeRemoval = context.parent;
  const rootAfterRemoval = removeSnippetNode(active.root, node.id);
  const parent = findSnippetNode(rootAfterRemoval, parentBeforeRemoval.id);
  if (!parent) {
    return false;
  }

  const nextSibling = parentBeforeRemoval.children
    .slice(context.index + 1)
    .find((child) => child.hostFieldNumber === parent.activeNumber);
  if (nextSibling) {
    const nextSiblingInTree = findSnippetNode(rootAfterRemoval, nextSibling.id);
    const number = nextSiblingInTree ? nextSiblingInTree.activeNumber : null;
    if (nextSiblingInTree && number !== null) {
      dispatchActiveSelection(dispatch, state, rootAfterRemoval, nextSiblingInTree, number);
      return true;
    }
  }

  const nextNumber = nextNumberAfter(parent, parent.activeNumber);
  if (nextNumber !== undefined) {
    const child = childForField(parent, nextNumber);
    if (child) {
      dispatchActiveSelection(dispatch, state, rootAfterRemoval, child, child.activeNumber);
    } else {
      const nextRoot = setNodeActiveNumber(rootAfterRemoval, parent.id, nextNumber);
      const nextParent = findSnippetNode(nextRoot, parent.id);
      if (!nextParent) {
        return false;
      }
      dispatchActiveSelection(dispatch, state, nextRoot, nextParent, nextNumber);
    }
    return true;
  }

  // This parent has no later field, so its completion is the successor of
  // the child we just removed.  Recurse until an outer field (or the root)
  // can receive focus.
  const parentAfterRemoval = findSnippetNode(rootAfterRemoval, parent.id);
  if (!parentAfterRemoval) {
    return false;
  }
  return completeNodeAndFindSuccessor(
    state,
    { ...active, root: rootAfterRemoval, activeNodeId: parentAfterRemoval.id },
    parentAfterRemoval,
    dispatch
  );
}

export const nextCmSnippetField: StateCommand = ({ state, dispatch }) => {
  const snippet = getCmSnippetState(state);
  if (!snippet || snippet.kind === "finished") {
    return false;
  }

  const preferred = findSnippetNode(snippet.root, snippet.activeNodeId);
  const located = findDeepestSnippetField(
    snippet.root,
    state.selection,
    snippet.activeNodeId,
    preferred?.activeNumber
  );
  const node = located?.node ?? preferred;
  if (!node) {
    return false;
  }
  const currentNumber = located?.number ?? node.activeNumber;
  const nextNumber = nextNumberAfter(node, currentNumber);
  if (nextNumber === 0) {
    return destroyNodeAtFinalTabstop(state, snippet, node, dispatch);
  }
  if (nextNumber !== undefined) {
    const child = childForField(node, nextNumber);
    if (child) {
      dispatchActiveSelection(dispatch, state, snippet.root, child, child.activeNumber);
    } else {
      const nextRoot = setNodeActiveNumber(snippet.root, node.id, nextNumber);
      const nextNode = findSnippetNode(nextRoot, node.id);
      if (!nextNode) {
        return false;
      }
      dispatchActiveSelection(dispatch, state, nextRoot, nextNode, nextNumber);
    }
    return true;
  }

  return completeNodeAndFindSuccessor(state, snippet, node, dispatch);
};

export const prevCmSnippetField: StateCommand = ({ state, dispatch }) => {
  const snippet = getCmSnippetState(state);
  if (!snippet) {
    return false;
  }
  if (snippet.kind === "finished") {
    // `$0` ends snippet editing. Consume Shift-Tab so it cannot turn into
    // an unrelated indentation command after the snippet has finished.
    return true;
  }

  const preferred = findSnippetNode(snippet.root, snippet.activeNodeId);
  const located = findDeepestSnippetField(
    snippet.root,
    state.selection,
    snippet.activeNodeId,
    preferred?.activeNumber
  );
  const node = located?.node ?? preferred;
  if (!node) {
    return false;
  }

  const numbers = uniqueTabstopNumbers(node.tabstops).filter((number) => number !== 0);
  const currentNumber = located?.number ?? node.activeNumber;
  const currentIndex = currentNumber === 0 ? numbers.length : numbers.indexOf(currentNumber);
  const previousNumber = numbers[currentIndex - 1];
  if (previousNumber === undefined) {
    return false;
  }

  const nextRoot = setNodeActiveNumber(snippet.root, node.id, previousNumber);
  const nextNode = findSnippetNode(nextRoot, node.id);
  if (!nextNode) {
    return false;
  }
  dispatchActiveSelection(dispatch, state, nextRoot, nextNode, previousNumber);
  return true;
};

export const clearCmSnippet: StateCommand = ({ state, dispatch }) => {
  if (!getCmSnippetState(state)) {
    return false;
  }
  dispatch(state.update({ effects: clearCmSnippetEffect.of(undefined) }));
  return true;
};
