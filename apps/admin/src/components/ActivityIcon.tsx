/**
 * Inline SVG glyph for the activity-bar / sidebar. Purely presentational:
 * takes an icon key and returns the matching 24x24 stroke SVG.
 */
export function ActivityIcon({ icon }: { icon: string }) {
  const commonProps = {
    "aria-hidden": true,
    className: "activity-icon",
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
    viewBox: "0 0 24 24"
  };

  switch (icon) {
    case "explorer":
      return (
        <svg {...commonProps}>
          <path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
          <path d="M3.5 6.5v-1a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case "edit":
      return (
        <svg {...commonProps}>
          <path d="M4.5 19.5h4l9.5-9.5-4-4L4.5 15.5z" />
          <path d="M12.5 7.5l4 4" />
          <path d="M4.5 19.5l3-1" />
        </svg>
      );
    case "plugins":
      return (
        <svg {...commonProps}>
          <path d="M10 4.5h4v5h5v5h-5v5h-4v-5H5v-5h5z" />
        </svg>
      );
    case "outline":
      return (
        <svg {...commonProps}>
          <path d="M6 6.5h12" />
          <path d="M6 11.5h8" />
          <path d="M6 16.5h10" />
          <circle cx="18" cy="11.5" r="1.5" />
          <circle cx="18" cy="16.5" r="1.5" />
        </svg>
      );
    case "media":
      return (
        <svg {...commonProps}>
          <rect x="4" y="5" width="16" height="14" rx="2.5" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="M6.5 17l4.5-4.5 3.5 3.5 2-2 1.5 1.5" />
        </svg>
      );
    case "git":
      return (
        <svg {...commonProps}>
          <circle cx="8" cy="6.5" r="2" />
          <circle cx="16" cy="17.5" r="2" />
          <circle cx="16" cy="6.5" r="2" />
          <path d="M10 6.5h4" />
          <path d="M8 8.5v5a4 4 0 0 0 4 4h2" />
        </svg>
      );
    case "command":
      return (
        <svg {...commonProps}>
          <path d="M8.5 7.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0v9a2 2 0 1 1-4 0" />
          <path d="M19.5 7.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0v9a2 2 0 1 1-4 0" />
          <path d="M6.5 10.5h11" />
          <path d="M6.5 13.5h11" />
        </svg>
      );
    case "project":
      return (
        <svg {...commonProps}>
          <rect x="4" y="5" width="16" height="14" rx="2.5" />
          <path d="M8 9.5h8" />
          <path d="M8 13.5h5" />
          <path d="M8 17.5h8" />
        </svg>
      );
    default:
      return (
        <svg {...commonProps}>
          <rect x="5" y="5" width="14" height="14" rx="3" />
          <path d="M12 8v8" />
          <path d="M8 12h8" />
        </svg>
      );
  }
}
