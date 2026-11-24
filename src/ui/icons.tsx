// OpenShape's icon set: simple line drawings on a 24 × 24 grid, drawn with
// the current text colour so they follow hover and disabled states.

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PATHS = {
  menu: "M4 6h16M4 12h16M4 18h16",
  new: "M6 3h8l4 4v14H6zM14 3v4h4M12 11v6M9 14h6",
  open: "M3 7h6l2 2h10v10H3z",
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  saveAs: "M5 4h9l3 3v4M5 4v16h6M8 4v5h6M14 21v-2.5l5-5 2.5 2.5-5 5z",
  import: "M12 3v11M7 9l5 5 5-5M4 17v3h16v-3",
  export: "M12 14V3M7 8l5-5 5 5M4 17v3h16v-3",
  model: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  drawing: "M3 5h18v14H3zM6 9h5v6H6zM14 9h4v3h-4zM14 15h4",
  sketch: "M4 20h7M15 4l5 5-10 10H5v-5z",
  extrude: "M4 17l8 4 8-4-8-4zM12 3v8M9 6l3-3 3 3",
  revolve: "M12 2v20M18.5 9.5C18.5 7.6 15.6 6 12 6S5.5 7.6 5.5 9.5 8.4 13 12 13M15 10.5l-3 2.5 3 2.5",
  sweep: "M3 17h4v4H3zM5 17c0-7 5-12 13-12M15 2l3 3-3 3",
  loft: "M5 20h14M5 20l3-12M19 20l-3-12M8 7a4 1.5 0 0 0 8 0a4 1.5 0 0 0-8 0",
  fillet: "M4 20V12a8 8 0 0 1 8-8h8",
  chamfer: "M4 20V10l6-6h10",
  cove: "M4 20V4h6a10 10 0 0 0 10 10v6",
  pushpull: "M4 15l8 4 8-4-8-4zM12 2v8M9 5l3-3 3 3",
  shell: "M4 6h16v14H4zM8 6v10h8V6",
  draft: "M7 4h10l3 16H4z",
  boolean: `${circle(9, 12, 6)}${circle(15, 12, 6)}`,
  mirror: "M12 3v18M9 7L4 17h5zM15 7l5 10h-5z",
  pattern: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  plane: "M7 6h14l-4 12H3z",
  layflat: "M3 21h18M7 11h10v7H7zM12 2v6M9.5 5.5 12 8l2.5-2.5",
  move: "M12 3v18M3 12h18M9 6l3-3 3 3M6 15l-3-3 3-3M15 18l-3 3-3-3M18 9l3 3-3 3",
  print: "M7 9V3h10v6M7 17H4v-8h16v8h-3M7 13h10v8H7z",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  section: "M4 7.5L12 3l8 4.5v9L12 21l-8-4.5zM12 3v18M14.5 9l3-1.5M14.5 13l3-1.5M14.5 17l3-1.5",
  overhang: "M3 5h18v4H3zM10 9v12h4V9M4.5 12l2-2M17.5 12l2-2M4.5 15.5l5.5-5.5M14 10l5.5 5.5",
  inspect: `${circle(10, 10, 6)}M14.5 14.5 21 21`,
  measure: "M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2",
  close: "M6 6l12 12M18 6L6 18",
  teardrop: "M12 3l6 6a8.5 8.5 0 1 1-12 0z",
  holefit: `${circle(12, 12, 5)}${circle(12, 12, 8.5)}M12 1.5v3M12 19.5v3`,
  insert: "M8 3h8v4H8zM9 7v14h6V7M9 10.5h6M9 14h6M9 17.5h6M5 21h14",
  thinwall: "M4 4v16M20 4v16M10 4v16M14 4v16M10 12h4M7 12H4M17 12h3",
  search: `${circle(10.5, 10.5, 6.5)}M15.5 15.5 21 21`,
  split: "M3 6h7v12H3zM14 6h7v12h-7z",
  splitface: "M4 4h16v16H4zM4 15l16-6",
  faceoffset: "M3 20l4-4h13l-4 4zM6 10l4-4h11l-4 4zM12 16v-6",
  replaceface: "M4 12h9v8H4zM19 3v18M8 12V8h11",
  align: "M4 3v18M8 6h12v4H8zM8 14h7v4H8z",
  symmetry: "M12 3v18M4 7c3 0 5 2 5 5s-2 5-5 5M20 7c-3 0-5 2-5 5s2 5 5 5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The icon of each feature type, for the history and menus. */
export const FEATURE_ICON = {
  sketch: "sketch",
  plane: "plane",
  extrude: "extrude",
  revolve: "revolve",
  sweep: "sweep",
  loft: "loft",
  fillet: "fillet",
  chamfer: "chamfer",
  cove: "cove",
  pushpull: "pushpull",
  shell: "shell",
  draft: "draft",
  boolean: "boolean",
  mirror: "mirror",
  pattern: "pattern",
  transform: "move",
  split: "split",
  splitface: "splitface",
  faceoffset: "faceoffset",
  replaceface: "replaceface",
  align: "align",
  symmetry: "symmetry",
  layflat: "layflat",
  teardrop: "teardrop",
  holefit: "holefit",
  insert: "insert",
  import: "import",
} as const satisfies Record<string, IconName>;
