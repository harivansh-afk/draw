import { createIcon } from "@excalidraw/excalidraw/components/icons";

export {
  searchIcon,
  share as shareIcon,
  copyIcon,
  LinkIcon,
  TrashIcon,
  DotsHorizontalIcon,
  usersIcon,
  loginIcon,
  eyeIcon,
  LoadIcon,
  DuplicateIcon,
  checkIcon,
  chevronDownIcon,
  HamburgerMenuIcon,
  SunIcon,
  MoonIcon,
  DeviceDesktopIcon,
  CloseIcon,
  pencilIcon,
  LockedIcon,
  PlusIcon,
  ExternalLinkIcon,
  frameToolIcon,
} from "@excalidraw/excalidraw/components/icons";

const tabler = {
  width: 24,
  height: 24,
  fill: "none",
  strokeWidth: 1.5,
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const folderIcon = createIcon(
  <g>
    <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" />
  </g>,
  tabler,
);

export const folderMoveIcon = createIcon(
  <g>
    <path d="M12 19h-7a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v3" />
    <path d="M16 19h6" />
    <path d="M19 16l3 3l-3 3" />
  </g>,
  tabler,
);

export const layoutGridIcon = createIcon(
  <g>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <rect x="14" y="14" width="6" height="6" rx="1" />
  </g>,
  tabler,
);

export const logoutIcon = createIcon(
  <g>
    <path d="M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2" />
    <path d="M9 12h12l-3 -3" />
    <path d="M18 15l3 -3" />
  </g>,
  tabler,
);

export const restoreIcon = createIcon(
  <g>
    <path d="M3.06 13a9 9 0 1 0 .49 -4.087" />
    <path d="M3 4.001v5h5" />
    <path d="M12 8v4l3 3" />
  </g>,
  tabler,
);

export const worldIcon = createIcon(
  <g>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.6 9h16.8" />
    <path d="M3.6 15h16.8" />
    <path d="M11.5 3a17 17 0 0 0 0 18" />
    <path d="M12.5 3a17 17 0 0 1 0 18" />
  </g>,
  tabler,
);

export const uploadIcon = createIcon(
  <g>
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" />
    <path d="M7 9l5 -5l5 5" />
    <path d="M12 4l0 12" />
  </g>,
  tabler,
);

export const sortIcon = createIcon(
  <g>
    <path d="M3 9l4 -4l4 4m-4 -4v14" />
    <path d="M21 15l-4 4l-4 -4m4 4v-14" />
  </g>,
  tabler,
);

export const emptyCanvasIcon = createIcon(
  <g strokeWidth="1">
    <rect x="3" y="4" width="18" height="14" rx="2" />
    <path d="M7 14l3 -3l2 2l3 -4l2 3" />
  </g>,
  tabler,
);

export const arrowLeftIcon = createIcon(
  <g>
    <path d="M5 12l14 0" />
    <path d="M5 12l6 6" />
    <path d="M5 12l6 -6" />
  </g>,
  tabler,
);

export const chevronUpDownIcon = createIcon(
  <g>
    <path d="M8 9l4 -4l4 4" />
    <path d="M16 15l-4 4l-4 -4" />
  </g>,
  tabler,
);

export const collectionIcon = createIcon(
  <g>
    <rect x="6" y="3" width="12" height="18" rx="1.5" />
    <path d="M9 3v18" />
    <path d="M6 8h3" />
    <path d="M6 12h3" />
    <path d="M6 16h3" />
  </g>,
  tabler,
);

export const importIcon = createIcon(
  <g>
    <path d="M4 12h11" />
    <path d="M11 8l4 4l-4 4" />
    <path d="M19 4v16" />
  </g>,
  tabler,
);

export const filePlusIcon = createIcon(
  <g>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />
    <path d="M12 11l0 6" />
    <path d="M9 14l6 0" />
  </g>,
  tabler,
);

export const trashSceneIcon = createIcon(
  <g strokeWidth="1.25">
    <path d="M5 5l14 14" />
    <path d="M19 5l-14 14" />
  </g>,
  tabler,
);
