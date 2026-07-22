import {
  COMMUTATIVE_FENCE_LANGUAGE,
  createEmptyCommutativeDocument,
  encodeCommutativeBase64,
  parseCommutative,
  parseTikzcd,
  renderCommutativeFence,
  stripTikzcdWrappers
} from "@blog-system/commutative";
import { getErrorMessage } from "@blog-system/content-core";

import type * as monacoEditor from "monaco-editor";
import type { PluginDefinition, WorkbenchDocument } from "../types";

const INSERT_COMMAND_ID = "commutative.insertBlock";
const EDIT_CURRENT_COMMAND_ID = "commutative.editCurrentBlock";
const MODAL_ID = "commutative-modal-root";
const STYLE_ID = "commutative-admin-style";

interface CommutativeFenceBlock {
  content: string;
  endLineNumber: number;
  infoString: string;
  range: monacoEditor.IRange;
  startLineNumber: number;
}

let activeMarkdownEditor: monacoEditor.editor.IStandaloneCodeEditor | null = null;
let activeMonacoApi: typeof monacoEditor | null = null;

function getBlockKey(block: CommutativeFenceBlock) {
  return `${block.startLineNumber}:${block.endLineNumber}:${block.content}`;
}

function getBlockSignature(blocks: CommutativeFenceBlock[]) {
  return blocks.map(getBlockKey).join("\n---commutative-block---\n");
}

function contentChangeMayAffectCommutativeBlocks(
  editor: monacoEditor.editor.IStandaloneCodeEditor,
  event: monacoEditor.editor.IModelContentChangedEvent
) {
  const model = editor.getModel();
  if (!model) {
    return true;
  }

  return event.changes.some((change) => {
    const insertedText = change.text;
    if (insertedText.includes("```") || insertedText.includes(COMMUTATIVE_FENCE_LANGUAGE)) {
      return true;
    }

    const startLine = Math.max(1, change.range.startLineNumber - 1);
    const endLine = Math.min(model.getLineCount(), change.range.endLineNumber + 1);
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      const line = model.getLineContent(lineNumber);
      if (line.includes("```") || line.includes(COMMUTATIVE_FENCE_LANGUAGE)) {
        return true;
      }
    }

    return false;
  });
}

function ensureAdminStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.commutative-modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(10, 14, 20, 0.44);
  backdrop-filter: blur(6px);
}

.commutative-modal__card {
  width: min(1280px, calc(100vw - 48px));
  height: min(860px, calc(100vh - 48px));
  display: grid;
  grid-template-rows: auto 1fr auto;
  border-radius: 20px;
  overflow: hidden;
  border: 1px solid var(--wb-border);
  background: var(--wb-bg-elevated);
  box-shadow: 0 28px 80px rgba(5, 10, 18, 0.28);
  color: var(--wb-foreground);
}

.commutative-modal__header,
.commutative-modal__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-bg-panel);
}

.commutative-modal__footer {
  border-top: 1px solid var(--wb-border);
  border-bottom: none;
}

.commutative-modal__title {
  font: 600 16px/1.2 "Georgia", serif;
  color: var(--wb-foreground);
}

.commutative-modal__actions {
  display: flex;
  gap: 10px;
}

.commutative-modal__button {
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  padding: 9px 14px;
  background: var(--wb-bg-elevated);
  color: var(--wb-foreground);
  font: 600 13px/1 "Cascadia Code", "Fira Code", monospace;
  cursor: pointer;
}

.commutative-modal__button.primary {
  background: var(--wb-bg-active);
  color: var(--wb-foreground);
  border-color: var(--wb-bg-active);
}

.commutative-modal__iframe {
  width: 100%;
  height: 100%;
  border: none;
  background: var(--wb-bg);
}

.commutative-modal__status {
  font: 500 12px/1.3 "Georgia", serif;
  color: var(--wb-foreground-muted);
}
`;
  document.head.appendChild(style);
}

function isMarkdownDocument(document: WorkbenchDocument | null) {
  return Boolean(
    document &&
      (document.kind === "article" ||
        document.kind === "project" ||
        document.kind === "projectTask" ||
        document.kind === "projectLog")
  );
}

/**
 * Build a commutative fence block string for insertion into Monaco.
 * The body is now tikzcd LaTeX (not base64). The info-string preserves
 * any `width/scale/align` params from the original block.
 */
function buildCommutativeFence(latexBody: string, infoString = "") {
  const info = infoString ? ` ${infoString}` : "";
  return `\`\`\`${COMMUTATIVE_FENCE_LANGUAGE}${info}\n${latexBody}\n\`\`\`\n`;
}

function findCommutativeBlocks(model: monacoEditor.editor.ITextModel): CommutativeFenceBlock[] {
  const matches = model.findMatches(
    "^```commutative[^\\n]*\\n([\\s\\S]*?)\\n```[ \\t]*$",
    true,
    true,
    true,
    null,
    true
  );

  return matches.map((match) => {
    const fullText = model.getValueInRange(match.range);
    const firstLineBreak = fullText.indexOf("\n");
    const lastFenceIndex = fullText.lastIndexOf("\n```");
    // Extract info-string: everything after "commutative" on the opening line.
    const firstLine = firstLineBreak >= 0 ? fullText.slice(0, firstLineBreak) : fullText;
    const infoString = firstLine.startsWith("```commutative")
      ? firstLine.slice("```commutative".length)
      : "";
    const content =
      firstLineBreak >= 0 && lastFenceIndex > firstLineBreak
        ? fullText.slice(firstLineBreak + 1, lastFenceIndex)
        : "";

    return {
      content,
      endLineNumber: match.range.endLineNumber,
      infoString,
      range: match.range,
      startLineNumber: match.range.startLineNumber
    };
  });
}

function findBlockAtSelection(editor: monacoEditor.editor.IStandaloneCodeEditor) {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) {
    return null;
  }

  return (
    findCommutativeBlocks(model).find(
      (block) =>
        selection.startLineNumber >= block.startLineNumber &&
        selection.startLineNumber <= block.endLineNumber
    ) ?? null
  );
}

function openCommutativeModal(
  editor: monacoEditor.editor.IStandaloneCodeEditor,
  block: CommutativeFenceBlock
) {
  ensureAdminStyles();

  const existing = document.getElementById(MODAL_ID);
  existing?.remove();

  const root = document.createElement("div");
  root.id = MODAL_ID;
  root.className = "commutative-modal";

  // Parse the LaTeX body to a CommutativeDocument, then encode to base64
  // for the iframe URL hash. The iframe still reads base64 from the hash
  // (quiver's own code path), so this is just an internal transport format.
  let startingDocument;
  const normalizedBody = stripTikzcdWrappers(block.content);
  const parseResult = parseTikzcd(normalizedBody);
  if (parseResult.ok) {
    startingDocument = parseResult.document;
  } else {
    // Fallback: try legacy base64 decode for backward compatibility during
    // the transition period (before migration has run).
    try {
      startingDocument = parseCommutative(block.content);
    } catch {
      startingDocument = createEmptyCommutativeDocument();
    }
  }

  const encoded = encodeCommutativeBase64(startingDocument);
  const iframe = document.createElement("iframe");
  iframe.className = "commutative-modal__iframe";
  iframe.src = `/quiver/index.html?admin=1&r=katex#q=${encodeURIComponent(encoded)}`;
  iframe.addEventListener("load", () => {
    try {
      const iframeDoc = iframe.contentDocument ?? iframe.contentWindow?.document;
      if (!iframeDoc) return;
      const globalPanel = iframeDoc.querySelector(".global");
      if (globalPanel) (globalPanel as HTMLElement).style.display = "none";
    } catch {
      // Ignore cross-origin access failures.
    }
  });

  let isClosed = false;

  const teardownMessageListener = () => {
    window.removeEventListener("message", messageHandler);
  };

  const close = () => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    teardownMessageListener();
    root.remove();
  };

  /**
   * On Apply: request the iframe to export its current state as tikzcd LaTeX
   * via postMessage. The iframe's new message handler calls
   * `QuiverImportExport.tikz_cd.export(...)` and returns the LaTeX string,
   * which we strip of its `\begin{tikzcd}/\end{tikzcd}` wrappers and write
   * back into the Monaco fence body.
   */
  const apply = () => {
    const iframeWindow = iframe.contentWindow;
    if (!iframeWindow) {
      window.alert("Commutative editor is not ready yet.");
      return;
    }
    // Send export request to the same-origin quiver iframe.
    iframeWindow.postMessage({ type: "export-tikz-cd" }, window.location.origin);
  };

  // Listen for the iframe's export response. The quiver page is served from
  // the same origin, so reject messages from anywhere else.
  const messageHandler = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) {
      return;
    }
    if (event.source !== iframe.contentWindow) {
      return;
    }
    if (event.data?.type !== "tikz-cd-export") return;
    const latexFull = event.data.data as string;
    const latexBody = stripTikzcdWrappers(latexFull);
    const nextFence = buildCommutativeFence(latexBody, block.infoString);
    editor.executeEdits("commutative-modal", [
      {
        range: block.range,
        text: nextFence
      }
    ]);
    close();
    editor.focus();
  };
  window.addEventListener("message", messageHandler);

  root.innerHTML = `
    <div class="commutative-modal__card" role="dialog" aria-modal="true" aria-label="Edit commutative diagram">
      <div class="commutative-modal__header">
        <div>
          <div class="commutative-modal__title">Commutative Editor</div>
          <div class="commutative-modal__status">Edit in Quiver, then Apply to write readable LaTeX back into Markdown.</div>
        </div>
        <div class="commutative-modal__actions">
          <button class="commutative-modal__button" data-action="cancel" type="button">Cancel</button>
        </div>
      </div>
      <div></div>
      <div class="commutative-modal__footer">
        <div class="commutative-modal__status">Stored format: tikzcd LaTeX inside \`\`\`commutative fences.</div>
        <div class="commutative-modal__actions">
          <button class="commutative-modal__button" data-action="cancel-footer" type="button">Close</button>
          <button class="commutative-modal__button primary" data-action="apply" type="button">Apply</button>
        </div>
      </div>
    </div>
  `;

  const bodySlot = root.querySelector(".commutative-modal__card > div:nth-child(2)");
  bodySlot?.appendChild(iframe);

  root.addEventListener("click", (event) => {
    if (event.target === root) {
      close();
    }
  });
  root.querySelector('[data-action="cancel"]')?.addEventListener("click", close);
  root.querySelector('[data-action="cancel-footer"]')?.addEventListener("click", close);
  root.querySelector('[data-action="apply"]')?.addEventListener("click", () => {
    try {
      apply();
    } catch (error) {
      window.alert(getErrorMessage(error));
    }
  });

  document.body.appendChild(root);
}

function insertCommutativeBlockAtSelection(
  editor: monacoEditor.editor.IStandaloneCodeEditor,
  monaco: typeof monacoEditor
) {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) {
    return false;
  }

  // Insert an empty diagram: minimal LaTeX placeholder.
  const snippet = buildCommutativeFence("% empty diagram");
  const containingBlock = findCommutativeBlocks(model).find(
    (block) =>
      selection.startLineNumber >= block.startLineNumber &&
      selection.startLineNumber <= block.endLineNumber
  );
  const insertionRange = containingBlock
    ? containingBlock.endLineNumber < model.getLineCount()
      ? new monaco.Range(
          containingBlock.endLineNumber + 1,
          1,
          containingBlock.endLineNumber + 1,
          1
        )
      : new monaco.Range(
          model.getLineCount(),
          model.getLineMaxColumn(model.getLineCount()),
          model.getLineCount(),
          model.getLineMaxColumn(model.getLineCount())
        )
    : selection;
  const insertionText =
    containingBlock && containingBlock.endLineNumber >= model.getLineCount() ? `\n${snippet}` : snippet;

  editor.executeEdits("commutative-insert", [
    {
      range: insertionRange,
      text: insertionText
    }
  ]);

  const insertedLine = containingBlock ? containingBlock.endLineNumber + 1 : selection.startLineNumber;
  editor.setPosition({
    lineNumber: insertedLine + 1,
    column: 1
  });
  editor.focus();

  window.setTimeout(() => {
    const nextModel = editor.getModel();
    if (!nextModel) {
      return;
    }

    const blocks = findCommutativeBlocks(nextModel);
    const insertedBlock =
      blocks.find((block) => block.startLineNumber === insertedLine) ??
      blocks.find(
        (block) => insertedLine >= block.startLineNumber && insertedLine <= block.endLineNumber
      );
    if (insertedBlock) {
      openCommutativeModal(editor, insertedBlock);
    }
  }, 120);
  return true;
}

function editCurrentCommutativeBlock(editor: monacoEditor.editor.IStandaloneCodeEditor) {
  const block = findBlockAtSelection(editor);
  if (!block) {
    window.alert("Place the cursor inside a commutative block first.");
    return false;
  }

  openCommutativeModal(editor, block);
  return true;
}

export const commutativePlugin: PluginDefinition = {
  id: "commutative",
  label: "Commutative",
  description: "Adds right-pane preview rendering and Quiver-based editing for fenced commutative blocks.",
  activate(context) {
    // Right-pane preview renderer: use `renderCommutativeFence` which
    // parses tikzcd LaTeX and emits an error placeholder on parse failure.
    context.registerMarkdownFenceRenderer({
      language: COMMUTATIVE_FENCE_LANGUAGE,
      name: "commutative",
      render(renderContext) {
        const output = renderCommutativeFence(renderContext.content, renderContext.meta);
        return {
          cssText: output.cssText,
          html: output.html
        };
      }
    });

    context.registerCommand({
      id: INSERT_COMMAND_ID,
      title: "Insert: Commutative",
      keywords: ["diagram", "quiver", "commutative", "graph", "markdown"],
      handler() {
        const editor = activeMarkdownEditor;
        const monaco = activeMonacoApi;
        if (!editor || !monaco) {
          return;
        }
        insertCommutativeBlockAtSelection(editor, monaco);
      }
    });

    context.registerCommand({
      id: EDIT_CURRENT_COMMAND_ID,
      title: "Edit: Current Commutative Diagram",
      keywords: ["diagram", "quiver", "commutative", "graph", "markdown"],
      handler() {
        const editor = activeMarkdownEditor;
        if (!editor) {
          return;
        }
        editCurrentCommutativeBlock(editor);
      }
    });

    context.registerMarkdownEditorFeature({
      id: "commutative-markdown-source-tracking",
      matches(document) {
        return isMarkdownDocument(document);
      },
      onMount(editor, monaco, document) {
        if (!isMarkdownDocument(document)) {
          return;
        }

        activeMarkdownEditor = editor;
        activeMonacoApi = monaco;
        let blockSignature = "";
        const focusDisposable = editor.onDidFocusEditorText(() => {
          activeMarkdownEditor = editor;
          activeMonacoApi = monaco;
        });

        const contentDisposable = editor.onDidChangeModelContent((event) => {
          if (contentChangeMayAffectCommutativeBlocks(editor, event)) {
            const model = editor.getModel();
            if (!model) return;
            const blocks = findCommutativeBlocks(model);
            const nextSignature = getBlockSignature(blocks);
            if (nextSignature !== blockSignature) {
              blockSignature = nextSignature;
            }
          }
        });
        const modelDisposable = editor.onDidChangeModel(() => {
          blockSignature = "";
        });

        return () => {
          if (activeMarkdownEditor === editor) {
            activeMarkdownEditor = null;
          }
          if (activeMonacoApi === monaco) {
            activeMonacoApi = null;
          }
          focusDisposable.dispose();
          contentDisposable.dispose();
          modelDisposable.dispose();
        };
      }
    });
  }
};
