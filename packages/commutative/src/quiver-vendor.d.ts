/**
 * Type declarations for the vendored quiver runtime modules under
 * `packages/commutative/vendor/quiver/*.mjs` — plain JavaScript without JSDoc
 * types. Only the surface this package consumes is declared; signatures mirror
 * the implementations in the .mjs sources. The wildcard patterns match the
 * relative imports in `quiver-geometry.ts`. This vendor directory is the
 * canonical copy of the quiver assets (the admin iframe bundle is synced from
 * here by `scripts/sync-quiver.mjs`).
 */
declare module "*/quiver/ds.mjs" {
  export class Enum {
    constructor(name: string, ...variants: string[]);
    [variant: string]: symbol;
  }

  export function url_parameters(): URLSearchParams;

  export class Point {
    constructor(x: number, y: number);
    x: number;
    y: number;
    static zero(): Point;
    static lendir(length: number, direction: number): Point;
    static diag(x: number): Point;
    toString(): string;
    toArray(): [number, number];
    px(comma?: boolean): string;
    eq(other: Point): boolean;
    add(other: Point): Point;
    sub(other: Point): Point;
    neg(): Point;
    scale(w: number, h: number): Point;
    inv_scale(w: number, h: number): Point;
    mul(multiplier: number): Point;
    div(divisor: number): Point;
    max(other: Point): Point;
    min(other: Point): Point;
    rotate(theta: number): Point;
    length(): number;
    angle(): number;
    lerp(other: Point, t: number): Point;
    is_zero(): boolean;
    map(f: (value: number) => number): Point;
  }

  export class Position extends Point {}
  export class Offset extends Point {}

  export class Dimensions extends Position {
    static zero(): Dimensions;
    get width(): number;
    get height(): number;
  }

  export function rad_to_deg(rad: number): number;
  export function deg_to_rad(deg: number): number;

  export class Path {
    commands: string[];
    toString(): string;
    move_to(p: Point): this;
    move_by(p: Point): this;
    line_to(p: Point): this;
    line_by(p: Point): this;
    curve_by(c: Point, d: Point): this;
    arc_by(
      r: Point,
      angle: number,
      large_arc: boolean,
      clockwise: boolean | number,
      next: Point
    ): this;
  }

  export function clamp(min: number, x: number, max: number): number;
  export function arrays_equal(array1: unknown[], array2: unknown[]): boolean;
  export function mod(x: number, y: number): number;
}

declare module "*/quiver/curve.mjs" {
  import { Dimensions, Path, Point } from "*/quiver/ds.mjs";

  export const EPSILON: number;

  export class Curve {
    static point_inside_polygon(point: Point, points: Point[]): boolean;
  }

  export class Bezier extends Curve {
    constructor(origin: Point, w: number, h: number, angle: number);
    origin: Point;
    w: number;
    h: number;
    angle: number;
    end: Point;
    control: Point;
    point(t: number): Point;
    tangent(t: number): number;
    delineate(t: number): { points: [number, Point][]; length: number };
    arc_length(t: number): number;
    t_after_length(clamp?: boolean): (length: number) => number;
    get height(): number;
    get width(): number;
    intersections_with_rounded_rectangle(
      rect: RoundedRectangle,
      permit_containment: boolean
    ): CurvePoint[];
    render(path: Path): Path;
  }

  /**
   * NOTE: at runtime a CurvePoint also carries an own `angle` data property
   * that shadows `Point.angle()`; TypeScript cannot model the shadowing, so
   * it is intentionally left undeclared (no consumer reads it).
   */
  export class CurvePoint extends Point {
    constructor(point: Point, t: number, angle: number | null);
    t: number;
  }

  export class RoundedRectangle {
    constructor(centre: Point, size: Dimensions, radius: number);
    centre: Point;
    size: Dimensions;
    r: number;
    points(max_segment_length?: number): Point[];
  }

  export class Arc extends Curve {
    constructor(origin: Point, chord: number, major: boolean, radius: number, angle: number);
    origin: Point;
    chord: number;
    major: boolean;
    radius: number;
    angle: number;
    sagitta: number;
    centre: Point;
    start_angle: number;
    sweep_angle: number;
    get clockwise(): number;
    point(t: number): Point;
    tangent(t: number): number;
    arc_length(t: number): number;
    t_after_length(clamp?: boolean): (length: number) => number;
    get height(): number;
    get width(): number;
    angle_in_arc(angle: number): boolean;
    intersections_with_rounded_rectangle(
      rect: RoundedRectangle,
      permit_containment: boolean
    ): CurvePoint[];
    render(path: Path): Path;
  }
}
