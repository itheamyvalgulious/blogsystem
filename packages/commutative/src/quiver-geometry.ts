import { Arc, Bezier, Curve, CurvePoint, EPSILON, RoundedRectangle } from "../vendor/quiver/curve.mjs";
import { Dimensions, Enum, Path, Point, clamp, deg_to_rad, url_parameters as quiverUrlParameters } from "../vendor/quiver/ds.mjs";

export { Arc, Bezier, Curve, CurvePoint, Dimensions, Enum, EPSILON, Path, Point, RoundedRectangle, clamp, deg_to_rad };

/** quiver `ds.mjs` 的 url_parameters 转发导出（显式签名保证 d.ts 稳定）。 */
export const url_parameters: () => URLSearchParams = quiverUrlParameters;

export const QUIVER_CONSTANTS = {
  ADJUNCTION_LINE_LENGTH: 16,
  ARC: {
    INNER_DIS: 64,
    OUTER_DIS: 96
  },
  ARROW_BODY_STYLE: new Enum(
    "ARROW_BODY_STYLE",
    "NONE",
    "LINE",
    "SQUIGGLY",
    "ADJUNCTION",
    "PROARROW",
    "DOUBLE_PROARROW",
    "BULLET_SOLID",
    "BULLET_HOLLOW"
  ),
  ARROW_DASH_STYLE: new Enum("ARROW_DASH_STYLE", "SOLID", "DASHED", "DOTTED"),
  ARROW_HEAD_STYLE: {
    CORNER: ["corner"],
    CORNER_INVERSE: ["corner-inverse"],
    EPI: ["epi", "epi"],
    HARPOON_BOTTOM: ["harpoon-bottom"],
    HARPOON_TOP: ["harpoon-top"],
    HOOK_BOTTOM: ["hook-bottom"],
    HOOK_TOP: ["hook-top"],
    MAPS_TO: ["maps to"],
    MONO: ["mono"],
    NONE: [],
    NORMAL: ["epi"]
  },
  ARROW_SHAPE: new Enum("ARROW_SHAPE", "BEZIER", "ARC"),
  BACKGROUND_PADDING: 16,
  CONTENT_PADDING: 8,
  CURVE_HEIGHT: 24,
  EDGE_LABEL_PADDING: 8,
  EDGE_OFFSET_DISTANCE: 8,
  HEAD_SPACING: 2,
  LABEL_ALIGNMENT: new Enum("LABEL_ALIGNMENT", "CENTRE", "OVER", "LEFT", "RIGHT"),
  LINE_SPACING: 4.5,
  LOOP_HEIGHT: 16,
  MASK_PADDING: 4,
  SQUIGGLY_PADDING: 4,
  SQUIGGLY_TRIANGLE_HEIGHT: 2,
  STROKE_WIDTH: 1.5
} as const;

export class QuiverArrowStyle {
  colour: string | undefined = "black";
  curve = 0;
  dash_style = QUIVER_CONSTANTS.ARROW_DASH_STYLE.SOLID;
  body_style = QUIVER_CONSTANTS.ARROW_BODY_STYLE.LINE;
  heads: readonly string[] = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.NORMAL;
  label_position = 0.5;
  level = 1;
  shape = QUIVER_CONSTANTS.ARROW_SHAPE.BEZIER;
  shift = 0;
  shorten = { head: 0, tail: 0 };
  tails: readonly string[] = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.NONE;
  angle = 0;
}

export class QuiverLabel {
  alignment = QUIVER_CONSTANTS.LABEL_ALIGNMENT.CENTRE;
  size = Dimensions.zero();
}

export class QuiverShape {
  origin!: Point;
  size!: Dimensions;
  radius!: number;

  point() {
    return new QuiverShape.Endpoint(this.origin);
  }

  static Endpoint: typeof QuiverShapeEndpoint;
  static RoundedRect: typeof QuiverShapeRoundedRect;
}

class QuiverShapeRoundedRect extends QuiverShape {
  constructor(origin: Point, size: Dimensions, radius: number) {
    super();
    this.origin = origin;
    this.size = size;
    this.radius = radius;
  }
}

class QuiverShapeEndpoint extends QuiverShape {
  constructor(origin: Point) {
    super();
    this.origin = origin;
    this.size = Dimensions.zero();
    this.radius = 0;
  }
}

QuiverShape.RoundedRect = QuiverShapeRoundedRect;
QuiverShape.Endpoint = QuiverShapeEndpoint;

function includesAny(array: readonly string[], ...values: string[]) {
  return !values.every((element) => !array.includes(element));
}

interface QuiverEdgeConstants {
  curve: Arc | Bezier;
  dash_padding: { end: number; start: number };
  end: CurvePoint | null;
  offset: Point;
  shorten: { end: number; start: number };
  start: CurvePoint | null;
  t_after_length: (length: number) => number;
}

interface QuiverEdgePathConstants extends QuiverEdgeConstants {
  total_width_of_heads: number;
  total_width_of_tails: number;
}

interface QuiverHeadConstants extends QuiverEdgeConstants {
  head_height: number;
  head_width: number;
  stroke_width: number;
}

export class QuiverArrowGeometry {
  source: QuiverShape;
  target: QuiverShape;
  style: QuiverArrowStyle;
  label: QuiverLabel | null;

  constructor(
    source: QuiverShape,
    target: QuiverShape,
    style: QuiverArrowStyle = new QuiverArrowStyle(),
    label: QuiverLabel | null = null
  ) {
    this.source = source;
    this.target = target;
    this.style = style;
    this.label = label;
  }

  origin() {
    const vector = this.target.origin.sub(this.source.origin);
    if (this.style.shape === QUIVER_CONSTANTS.ARROW_SHAPE.BEZIER || vector.length() > 0) {
      return { source: this.source.origin, target: this.target.origin };
    }

    const min_chord = 0.01;
    const angle = vector.angle() + this.style.angle;
    const nudge = Point.lendir(min_chord / 2, angle);
    return { source: this.source.origin.sub(nudge), target: this.target.origin.add(nudge) };
  }

  vector() {
    const origin = this.origin();
    return origin.target.sub(origin.source);
  }

  angle() {
    return this.vector().angle();
  }

  length() {
    return this.vector().length();
  }

  curve(origin = this.origin().source, angle = this.angle()) {
    const length = this.length();
    switch (this.style.shape) {
      case QUIVER_CONSTANTS.ARROW_SHAPE.BEZIER:
        return new Bezier(origin, length, this.style.curve, angle);
      case QUIVER_CONSTANTS.ARROW_SHAPE.ARC:
        if (this.source === this.target) {
          return new Arc(origin, length, true, this.style.curve, angle);
        }
        return this.arc_for_chord(origin, length, this.style.curve, angle);
      default:
        return new Bezier(origin, length, this.style.curve, angle);
    }
  }

  find_endpoints() {
    const origin = this.origin();
    const find_endpoint = (endpoint_shape: QuiverShape, endpoint_origin: Point, prefer_min: boolean) => {
      const curve = this.curve();

      if (endpoint_shape instanceof QuiverShape.Endpoint || endpoint_shape.size.is_zero()) {
        const t = prefer_min ? 0 : 1;
        return new CurvePoint(
          endpoint_origin.sub(origin.source).rotate(-curve.angle),
          t,
          curve.tangent(t)
        );
      }

      const intersections = curve.intersections_with_rounded_rectangle(
        new RoundedRectangle(endpoint_origin, endpoint_shape.size, endpoint_shape.radius),
        false
      );
      if (intersections.length === 0) {
        throw new Error("No intersections found.");
      }

      intersections.sort((left, right) => left.t - right.t);
      if (
        this.style.shape === QUIVER_CONSTANTS.ARROW_SHAPE.BEZIER &&
        intersections.length > 1 &&
        Curve.point_inside_polygon(
          origin[prefer_min ? "target" : "source"],
          new RoundedRectangle(endpoint_origin, endpoint_shape.size, 0).points()
        )
      ) {
        throw new Error("The Bezier re-enters an endpoint rectangle.");
      }

      return intersections[prefer_min ? 0 : intersections.length - 1];
    };

    return [find_endpoint(this.source, origin.source, true), find_endpoint(this.target, origin.target, false)];
  }

  arc_for_chord(origin: Point, chord: number, loop_radius: number, angle: number) {
    const outer_dis = QUIVER_CONSTANTS.ARC.OUTER_DIS;
    const inner_dis = QUIVER_CONSTANTS.ARC.INNER_DIS;
    const semicircle_radius = inner_dis / 2;
    const boundary_dis = outer_dis - inner_dis;
    const sagitta =
      chord >= outer_dis ? EPSILON : semicircle_radius * ((outer_dis - chord) / boundary_dis);
    const r_for_sagitta = sagitta / 2 + chord ** 2 / (8 * sagitta);
    const radius =
      chord <= inner_dis
        ? semicircle_radius + ((inner_dis - chord) / inner_dis) * (loop_radius - semicircle_radius)
        : r_for_sagitta;
    return new Arc(origin, chord, chord <= inner_dis, radius, angle);
  }

  edge_path(constants: QuiverEdgePathConstants) {
    const {
      curve,
      dash_padding,
      end,
      offset,
      shorten,
      start,
      t_after_length,
      total_width_of_heads,
      total_width_of_tails
    } = constants;
    // Upstream quiver permits null start/end here; in practice the renderer
    // always passes real endpoints, and a null would throw on `.t` below just
    // as it does in the original JS.
    let arclen_to_start = curve.arc_length(start!.t) + (this.style.shorten.tail + shorten.start) - dash_padding.start;
    let arclen_to_end = curve.arc_length(end!.t) - (this.style.shorten.head + shorten.end) + dash_padding.end;
    let arclen = curve.arc_length(1);
    const halfWavelength = QUIVER_CONSTANTS.SQUIGGLY_TRIANGLE_HEIGHT * 2;
    const path = new Path();

    switch (this.style.body_style) {
      case QUIVER_CONSTANTS.ARROW_BODY_STYLE.LINE:
      case QUIVER_CONSTANTS.ARROW_BODY_STYLE.PROARROW:
      case QUIVER_CONSTANTS.ARROW_BODY_STYLE.DOUBLE_PROARROW:
      case QUIVER_CONSTANTS.ARROW_BODY_STYLE.BULLET_SOLID:
      case QUIVER_CONSTANTS.ARROW_BODY_STYLE.BULLET_HOLLOW:
        path.move_to(offset);
        curve.render(path);
        break;
      case QUIVER_CONSTANTS.ARROW_BODY_STYLE.ADJUNCTION: {
        const centre = curve.point(0.5).add(offset);
        const angle = curve.tangent(0.5);
        const normal = angle + Math.PI / 2;
        const segment = new Point(QUIVER_CONSTANTS.ADJUNCTION_LINE_LENGTH, 0);
        const half = segment.div(2);
        path.move_to(centre.sub(half.rotate(angle)));
        path.line_by(segment.rotate(angle));
        path.move_to(centre.add(half.rotate(angle)).sub(half.rotate(normal)));
        path.line_by(segment.rotate(normal));
        break;
      }
      case QUIVER_CONSTANTS.ARROW_BODY_STYLE.SQUIGGLY: {
        const arclen_to_squiggle_start =
          arclen_to_start + total_width_of_tails + QUIVER_CONSTANTS.SQUIGGLY_PADDING;
        const squiggle_start_point = curve.point(t_after_length(arclen_to_squiggle_start));
        const arclen_to_squiggle_end =
          arclen_to_end - (total_width_of_heads + QUIVER_CONSTANTS.SQUIGGLY_PADDING);
        const start_point = curve.point(t_after_length(arclen_to_start));
        const end_point = curve.point(t_after_length(arclen_to_end));

        path.move_to(start_point.add(offset));
        path.line_to(squiggle_start_point.add(offset));

        let path_len = squiggle_start_point.sub(start_point).length();
        let prev_point = squiggle_start_point;
        for (let l = arclen_to_squiggle_start, sign = -1, m = 1; l + (m * halfWavelength) / 2 < arclen_to_squiggle_end; sign = [sign, -sign][m], m = 1 - m) {
          l += halfWavelength / 2;
          const t = t_after_length(l);
          const angle = curve.tangent(t) + (Math.PI / 2) * sign;
          const next_point = curve
            .point(t)
            .add(Point.lendir(QUIVER_CONSTANTS.SQUIGGLY_TRIANGLE_HEIGHT * m, angle));
          path_len += next_point.sub(prev_point).length();
          prev_point = next_point;
          path.line_to(next_point.add(offset));
        }

        path.line_to(end_point.add(offset));
        path_len += end_point.sub(prev_point).length();
        arclen_to_start = 0;
        arclen_to_end = arclen = path_len + dash_padding.start + dash_padding.end;
        break;
      }
      default:
        break;
    }

    if (
      this.style.body_style === QUIVER_CONSTANTS.ARROW_BODY_STYLE.ADJUNCTION ||
      start === null ||
      end === null
    ) {
      return { dash_array: null, path };
    }

    let arclen_line = arclen_to_end - arclen_to_start;
    let dashes = [arclen_line];

    if (this.style.dash_style !== QUIVER_CONSTANTS.ARROW_DASH_STYLE.SOLID) {
      switch (this.style.body_style) {
        case QUIVER_CONSTANTS.ARROW_BODY_STYLE.SQUIGGLY:
          if (this.style.level > 1) {
            break;
          }
        // fallthrough: squiggly at level 1 shares the dash computation with line-like bodies
        case QUIVER_CONSTANTS.ARROW_BODY_STYLE.LINE:
        case QUIVER_CONSTANTS.ARROW_BODY_STYLE.PROARROW:
        case QUIVER_CONSTANTS.ARROW_BODY_STYLE.DOUBLE_PROARROW:
        case QUIVER_CONSTANTS.ARROW_BODY_STYLE.BULLET_SOLID:
        case QUIVER_CONSTANTS.ARROW_BODY_STYLE.BULLET_HOLLOW: {
          dashes = [];

          if (this.style.body_style === QUIVER_CONSTANTS.ARROW_BODY_STYLE.SQUIGGLY) {
            const DASH_OFFSET = 4;
            dashes.push(total_width_of_tails + DASH_OFFSET);
            dashes.push(0);
            arclen_line -= total_width_of_tails + total_width_of_heads - DASH_OFFSET;
          }

          if (arclen_line > 0) {
            const triangleSide = halfWavelength * 2 ** 0.5;
            let dashPairs;
            if (this.style.body_style !== QUIVER_CONSTANTS.ARROW_BODY_STYLE.SQUIGGLY) {
              dashPairs =
                this.style.dash_style === QUIVER_CONSTANTS.ARROW_DASH_STYLE.DASHED ? [6, 6] : [2, 4];
            } else {
              dashPairs =
                this.style.dash_style === QUIVER_CONSTANTS.ARROW_DASH_STYLE.DASHED
                  ? [2 * triangleSide, triangleSide]
                  : [0.5 * triangleSide, 0.25 * triangleSide];
            }

            const dashGapLength = dashPairs.reduce((sum, value) => sum + value, 0);
            const dashesAndGaps = arclen_line / dashGapLength;
            dashes = dashes.concat(new Array(Math.floor(dashesAndGaps)).fill(dashPairs).flat());

            if (dashesAndGaps % 1 !== 0) {
              let deficit = arclen_line - Math.floor(dashesAndGaps) * dashGapLength;
              for (const value of dashPairs) {
                if (value <= deficit) {
                  dashes.push(value);
                  deficit -= value;
                } else {
                  break;
                }
              }
              dashes.push(deficit);
            }

            if (dashes.length % 2 !== 1) {
              dashes.push(0);
            }
          } else {
            dashes = [arclen_line];
            break;
          }

          if (this.style.body_style === QUIVER_CONSTANTS.ARROW_BODY_STYLE.SQUIGGLY) {
            dashes.push(0);
            dashes.push(total_width_of_heads);
          }
          break;
        }
        default:
          break;
      }
    }

    return {
      dash_array: `0 ${arclen_to_start} ${dashes.join(" ")} ${arclen - arclen_to_end}`,
      path
    };
  }

  redraw_heads(constants: QuiverHeadConstants, heads: readonly string[], endpoint: CurvePoint, is_start: boolean) {
    const { curve, head_height, head_width, offset, shorten, stroke_width, t_after_length } = constants;
    if (heads.length === 0) {
      return { path: new Path(), total_width: 0 };
    }

    const start_sign = is_start ? 1 : -1;
    const end_ind = is_start ? 0 : 1;
    const path = new Path();
    let total_width = 0;

    const arclen_to_endpoint =
      curve.arc_length(endpoint.t) +
      (is_start ? shorten.start + this.style.shorten.tail : shorten.end + this.style.shorten.head) *
        start_sign;

    if (includesAny(heads, "harpoon-top", "harpoon-bottom")) {
      const edge_bottom = stroke_width + QUIVER_CONSTANTS.LINE_SPACING;
      const side_sign = heads.find((head) => head.startsWith("harpoon"))!.endsWith("top") ? 1 : -1;
      const t = t_after_length(arclen_to_endpoint);
      const angle = curve.tangent(t);
      const point = curve
        .point(t)
        .add(offset)
        .add(
          new Point(
            0,
            (side_sign * stroke_width) / 2 - (side_sign * QUIVER_CONSTANTS.STROKE_WIDTH) / 2
          ).rotate(angle)
        );
      path.move_to(point);
      path.arc_by(
        new Point(start_sign * head_width, edge_bottom),
        angle,
        false,
        side_sign === 1 ? end_ind : 1 - end_ind,
        new Point(start_sign * head_width, -edge_bottom * side_sign).rotate(angle)
      );
      total_width = head_width;
    } else if (includesAny(heads, "hook-top", "hook-bottom")) {
      const t = t_after_length(arclen_to_endpoint);
      const base_point = curve.point(t);
      const angle = curve.tangent(t);
      const side_sign = heads.find((head) => head.startsWith("hook"))!.endsWith("top") ? -1 : 1;
      const MASK_ADJUSTMENT = 0.5;
      for (let index = 0; index < this.style.level; index += 1) {
        const point = base_point
          .add(offset)
          .add(
            new Point(
              MASK_ADJUSTMENT,
              (side_sign * stroke_width) / 2 -
                (side_sign * QUIVER_CONSTANTS.STROKE_WIDTH) / 2 -
                side_sign * (QUIVER_CONSTANTS.LINE_SPACING + QUIVER_CONSTANTS.STROKE_WIDTH) * index
            ).rotate(angle)
          );
        path.move_to(point);
        path.arc_by(
          new Point(start_sign * head_width, head_width),
          angle,
          false,
          side_sign === 1 ? end_ind : 1 - end_ind,
          new Point(0, side_sign * head_width * 2).rotate(angle)
        );
      }
      total_width = 0;
    } else {
      const arclens_to_head: number[] = [];
      let prev_margin = 0;
      for (let index = 0, heads_arclen = 0; index < heads.length; index += 1) {
        let margin_left: number;
        let margin_right: number;
        let margin_begin: number;
        switch (heads[index]) {
          case "epi":
          case "corner":
          case "corner-inverse":
            [margin_left, margin_right, margin_begin] = [0, head_width, 0];
            break;
          case "mono":
            [margin_left, margin_right, margin_begin] = [0, head_width, head_width];
            break;
          case "maps to":
            [margin_left, margin_right, margin_begin] = [head_width / 2, head_width / 2, 0];
            break;
          default:
            [margin_left, margin_right, margin_begin] = [0, head_width, 0];
            break;
        }

        if (index === 0) {
          heads_arclen += margin_begin;
        } else {
          const collapse = heads[index] === heads[index - 1] ? 2 : 1;
          heads_arclen += (prev_margin + margin_right) / collapse + QUIVER_CONSTANTS.HEAD_SPACING;
        }

        prev_margin = margin_left;
        arclens_to_head.push(heads_arclen);
        total_width = heads_arclen + margin_left;
      }

      for (let index = heads.length - 1; index >= 0; index -= 1) {
        const head_style = heads[index];
        const arclen_to_head = arclen_to_endpoint + arclens_to_head[index] * start_sign;
        const t = t_after_length(arclen_to_head);
        const point = curve.point(t).add(offset);
        let angle = curve.tangent(t);

        switch (head_style) {
          case "mono":
            angle += Math.PI;
          // fallthrough: mono arrowheads reuse the epi outline rotated 180°
          case "epi":
            for (const [side_sign, side_ind] of [
              [-1, end_ind],
              [1, 1 - end_ind]
            ]) {
              path.move_to(point);
              path.arc_by(
                new Point(start_sign * head_width, head_height / 2),
                angle,
                false,
                side_ind,
                new Point(start_sign * head_width, side_sign * head_height / 2).rotate(angle)
              );
            }
            break;
          case "corner":
          case "corner-inverse": {
            const is_inverse = head_style.endsWith("-inverse");
            const LENGTH = 12;
            const base_2 = LENGTH / 2 ** 0.5;
            const base_point = curve
              .point(t_after_length(arclen_to_head + (is_inverse ? 0 : base_2 * start_sign)))
              .add(offset);
            for (const side_sign of [-1, 1]) {
              path.move_to(base_point);
              const PI_4 = Math.PI / 4;
              const direction = this.angle();
              const corner_angle =
                (is_inverse ? 0 : Math.PI) + PI_4 * Math.round((4 * direction) / Math.PI) - direction;
              path.line_by(
                Point.lendir(
                  LENGTH,
                  corner_angle + Math.PI * end_ind + side_sign * (Math.PI / 4)
                )
              );
            }
            break;
          }
          case "maps to":
            path.move_to(point.add(Point.lendir(head_height / 2, angle + Math.PI / 2)));
            path.line_by(Point.lendir(head_height, angle - Math.PI / 2));
            break;
          default:
            break;
        }
      }
    }

    return { path, total_width };
  }
}

export interface QuiverArrowStyleOptions {
  angle?: number;
  colour?: string;
  curve?: number;
  label_position?: number;
  level?: number;
  offset?: number;
  radius?: number;
  shape?: string;
  shorten?: { source?: number; target?: number };
  style?: {
    body?: { name?: string };
    head?: { name?: string; side?: string };
    name?: string;
    tail?: { name?: string; side?: string };
  };
}

export function createQuiverArrowStyleFromOptions(options: QuiverArrowStyleOptions) {
  const style = new QuiverArrowStyle();
  style.label_position = (options.label_position ?? 50) / 100;
  style.shift = (options.offset ?? 0) * QUIVER_CONSTANTS.EDGE_OFFSET_DISTANCE;
  style.colour = options.colour;

  const arrowStyleName = options.style?.name ?? "arrow";
  switch (arrowStyleName) {
    case "arrow": {
      style.level = options.level ?? 1;
      // Upstream quiver keeps `shorten` as { source, target } percentages on
      // the style; the renderer converts them to absolute { head, tail }
      // lengths before `edge_path`/`redraw_heads` read them.
      style.shorten = (options.shorten ?? { source: 0, target: 0 }) as { head: number; tail: number };
      switch (options.shape) {
        case "arc": {
          style.shape = QUIVER_CONSTANTS.ARROW_SHAPE.ARC;
          const radius = [2, 3, 4][Math.floor(Math.abs(options.radius ?? 3) / 2)];
          style.curve = radius * Math.sign(options.radius ?? 3) * QUIVER_CONSTANTS.LOOP_HEIGHT;
          style.angle = deg_to_rad(options.angle ?? 0);
          break;
        }
        case "bezier":
        default:
          style.shape = QUIVER_CONSTANTS.ARROW_SHAPE.BEZIER;
          style.curve = (options.curve ?? 0) * QUIVER_CONSTANTS.CURVE_HEIGHT * 2;
          break;
      }

      switch (options.style?.body?.name) {
        case "squiggly":
          style.body_style = QUIVER_CONSTANTS.ARROW_BODY_STYLE.SQUIGGLY;
          break;
        case "barred":
          style.body_style = QUIVER_CONSTANTS.ARROW_BODY_STYLE.PROARROW;
          break;
        case "double barred":
          style.body_style = QUIVER_CONSTANTS.ARROW_BODY_STYLE.DOUBLE_PROARROW;
          break;
        case "bullet solid":
          style.body_style = QUIVER_CONSTANTS.ARROW_BODY_STYLE.BULLET_SOLID;
          break;
        case "bullet hollow":
          style.body_style = QUIVER_CONSTANTS.ARROW_BODY_STYLE.BULLET_HOLLOW;
          break;
        case "dashed":
          style.dash_style = QUIVER_CONSTANTS.ARROW_DASH_STYLE.DASHED;
          break;
        case "dotted":
          style.dash_style = QUIVER_CONSTANTS.ARROW_DASH_STYLE.DOTTED;
          break;
        case "none":
          style.body_style = QUIVER_CONSTANTS.ARROW_BODY_STYLE.NONE;
          break;
        default:
          break;
      }

      switch (options.style?.tail?.name) {
        case "maps to":
          style.tails = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.MAPS_TO;
          break;
        case "mono":
          style.tails = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.MONO;
          break;
        case "hook":
          style.tails =
            options.style?.tail?.side === "bottom"
              ? QUIVER_CONSTANTS.ARROW_HEAD_STYLE.HOOK_BOTTOM
              : QUIVER_CONSTANTS.ARROW_HEAD_STYLE.HOOK_TOP;
          break;
        case "arrowhead":
          style.tails = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.NORMAL;
          break;
        case "none":
        default:
          style.tails = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.NONE;
          break;
      }

      switch (options.style?.head?.name) {
        case "none":
          style.heads = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.NONE;
          break;
        case "epi":
          style.heads = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.EPI;
          break;
        case "harpoon":
          style.heads =
            options.style?.head?.side === "bottom"
              ? QUIVER_CONSTANTS.ARROW_HEAD_STYLE.HARPOON_BOTTOM
              : QUIVER_CONSTANTS.ARROW_HEAD_STYLE.HARPOON_TOP;
          break;
        case "arrowhead":
        default:
          style.heads = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.NORMAL;
          break;
      }
      break;
    }
    case "adjunction":
      style.body_style = QUIVER_CONSTANTS.ARROW_BODY_STYLE.ADJUNCTION;
      style.heads = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.NONE;
      break;
    case "corner":
      style.body_style = QUIVER_CONSTANTS.ARROW_BODY_STYLE.NONE;
      style.heads = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.NONE;
      style.tails = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.CORNER;
      break;
    case "corner-inverse":
      style.body_style = QUIVER_CONSTANTS.ARROW_BODY_STYLE.NONE;
      style.heads = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.NONE;
      style.tails = QUIVER_CONSTANTS.ARROW_HEAD_STYLE.CORNER_INVERSE;
      break;
    default:
      break;
  }

  return style;
}

export function updateQuiverLabelAlignment(label: QuiverLabel, alignment: 0 | 1 | 2 | 3) {
  label.alignment = {
    0: QUIVER_CONSTANTS.LABEL_ALIGNMENT.LEFT,
    1: QUIVER_CONSTANTS.LABEL_ALIGNMENT.CENTRE,
    2: QUIVER_CONSTANTS.LABEL_ALIGNMENT.RIGHT,
    3: QUIVER_CONSTANTS.LABEL_ALIGNMENT.OVER
  }[alignment];
}
