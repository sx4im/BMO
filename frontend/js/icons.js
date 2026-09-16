// Inline SVG icons (Lucide). No external runtime dependency.
// Each function returns a complete SVG string. Use via `el("span", { html: icon("settings") })`.

import { MARK_PATHS } from "./components/logo.js?v=31";
const SVG_BASE = (paths, { width = 16, height = 16, stroke = 2, name = "", className = "" } = {}) => {
  const cls = ["lucide-icon", name ? `icon-${name}` : "", className].filter(Boolean).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${paths}</svg>`;
};

const PATHS = {
  // Navigation / brand / composer
  imageSparkles: `<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M0.576355 6.73281c0.377607 -0.06826 0.766565 -0.1039 1.163835 -0.1039 1.57942 0 3.02726 0.56331 4.15358 1.5" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M5.07635 10.6289h-3.5c-0.26521 0 -0.51957 -0.1054 -0.707102 -0.2929 -0.187536 -0.1875 -0.292893 -0.44188 -0.292893 -0.70709v-8c0 -0.26522 0.105357 -0.51957 0.292893 -0.707111 0.187532 -0.187536 0.441892 -0.292893 0.707102 -0.292893h8c0.26522 0 0.51955 0.105357 0.70715 0.292893 0.1875 0.187541 0.2929 0.441891 0.2929 0.707111v3.5" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M6.32635 5.62891c0.69036 0 1.25 -0.55965 1.25 -1.25 0 -0.69036 -0.55964 -1.25 -1.25 -1.25 -0.69035 0 -1.25 0.55964 -1.25 1.25 0 0.69035 0.55965 1.25 1.25 1.25Z" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M7.33955 10.5629c-0.35093 -0.0611 -0.35093 -0.56487 0 -0.62592 1.27136 -0.22118 2.28255 -1.18955 2.5585 -2.45015l0.02115 -0.09663c0.07593 -0.34683 0.5698 -0.34899 0.6487 -0.00284l0.0257 0.11261c0.2862 1.25466 1.2976 2.21484 2.5655 2.43541 0.3527 0.06136 0.3527 0.56772 0 0.62912 -1.2679 0.2205 -2.2793 1.1807 -2.5655 2.4354l-0.0257 0.1126c-0.0789 0.3461 -0.57277 0.344 -0.6487 -0.0029l-0.02115 -0.0966c-0.27595 -1.2606 -1.28714 -2.229 -2.5585 -2.4501Z" stroke-width="1"/>`,
  userProfile: `<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M10.7045 12.0345c-0.2065 -0.7775 -0.653 -1.4723 -1.27879 -1.9838 -0.68453 -0.55951 -1.54144 -0.86515 -2.42553 -0.86515 -0.88409 0 -1.74099 0.30564 -2.42552 0.86515 -0.62578 0.5115 -1.07231 1.2063 -1.27876 1.9838" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M7 13.5c4.16 0 6.5 -2.34 6.5 -6.5S11.16 0.5 7 0.5 0.5 2.84 0.5 7s2.34 6.5 6.5 6.5Z" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M6.99902 7.58008c1.4 0 2.1875 -0.7875 2.1875 -2.1875s-0.7875 -2.1875 -2.1875 -2.1875 -2.1875 0.7875 -2.1875 2.1875 0.7875 2.1875 2.1875 2.1875Z" stroke-width="1"/>`,
  preferences: `<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M1 7h4.5" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M1 11.7188h9" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M8.5 7H13" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M13 2.28101H4" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M1 2.28125c0 0.96 0.54 1.5 1.5 1.5s1.5 -0.54 1.5 -1.5 -0.54 -1.5 -1.5 -1.5 1.5 0.54 -1.5 1.5Z" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M10 11.7187c0 0.96 0.54 1.5 1.5 1.5s1.5 -0.5399 1.5 -1.4999c0 -0.9601 -0.54 -1.5001 -1.5 -1.5001s-1.5 0.54 -1.5 1.5Z" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M5.52344 7c0 0.96 0.54 1.5 1.5 1.5s1.5 -0.54 1.5 -1.5 -0.54 -1.5 -1.5 -1.5 0.54 -1.5 1.5Z" stroke-width="1"/>`,
  planUsage: `<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M12.4809 5.89042H8.79114C8.08618 1.88565 9.86607 0.970708 10.906 1.00071c2.1599 0.33598 1.9849 3.3998 1.5749 4.88971Z" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M8.22499 12.5203C10.8734 9.43194 6.3021 2.29383 10.5511 1.00073H3.59127c-4.07156 1.2931 0.14398 8.66835 -2.32613 11.27467 0 0 0.83971 0.7246 3.41743 0.7246 2.57772 0 3.54242 -0.4797 3.54242 -0.4797Z" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="m4.33691 3.93921 1.85539 0" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="m4.57666 7.00024 1.85539 0" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="m4.57666 10.0615 1.85539 0" stroke-width="1"/>`,
  about: `<path d="M9 15c0.85038 0.6303 1.8846 1 3 1s2.1496 -0.3697 3 -1" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/><path fill="currentColor" d="M14 9.5a1 1.5 0 1 0 2 0 1 1.5 0 1 0 -2 0" stroke-width="1.5"/><path fill="currentColor" d="M8 9.5a1 1.5 0 1 0 2 0 1 1.5 0 1 0 -2 0" stroke-width="1.5"/><path d="M22 19.723v-7.4224C22 6.61173 17.5228 2 12 2 6.47715 2 2 6.61173 2 12.3006v7.4224c0 1.3223 1.35098 2.1824 2.4992 1.591 0.92806 -0.478 2.0336 -0.4071 2.89694 0.1858 0.97122 0.6669 2.2365 0.6669 3.20776 0l0.3526 -0.2422c0.6319 -0.4339 1.4551 -0.4339 2.087 0l0.3526 0.2422c0.9713 0.6669 2.2365 0.6669 3.2078 0 0.8633 -0.5929 1.9688 -0.6638 2.8969 -0.1858C20.649 21.9054 22 21.0453 22 19.723Z" stroke="currentColor" stroke-width="1.5"/>`,
  helpStudy: `<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M10 12.5002c1.3807 0 2.5 -1.1192 2.5 -2.5 0 -1.38067 -1.1193 -2.49996 -2.5 -2.49996 -1.38071 0 -2.5 1.11929 -2.5 2.49996 0 1.3808 1.11929 2.5 2.5 2.5Z" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="m13.4995 13.4998 -1.73 -1.73" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M7 2.00024v0C7 1.17182 6.32843 0.500244 5.5 0.500244h-5V10.5002h5" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M7 2.00024v4.5" stroke-width="1"/><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M7 2v0C7 1.17157 7.67157 0.5 8.5 0.5h5v7.00024" stroke-width="1"/>`,
  arrowLeft: `<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`,
  send: `<path d="m5 12 7-7 7 7" class="arrow-up-head"/><path d="M12 19V5" class="arrow-up-stem"/>`,
  arrowUp: `<path d="m5 12 7-7 7 7" class="arrow-up-head"/><path d="M12 19V5" class="arrow-up-stem"/>`,
  square: `<rect width="18" height="18" x="3" y="3" rx="2"/>`,
  squarePen: `<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" class="square-pen-nib"/>`,
  pencil: `<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>`,
  globe: `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,

  // Sections / navigation / identity
  messageSquare: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
  messageText: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M7 9h10"/><path d="M7 13h6"/>`,
  messageCircleMore: `<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 12h.01" class="dot dot-1"/><path d="M12 12h.01" class="dot dot-2"/><path d="M16 12h.01" class="dot dot-3"/>`,
  settings: `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
  user: `<circle cx="12" cy="8" r="5" class="user-head"/><path d="M20 21a8 8 0 0 0-16 0" class="user-body"/>`,
  sun: `<circle cx="12" cy="12" r="4" class="sun-core"/><path d="M12 2v2" class="sun-ray sun-ray-1"/><path d="m19.07 4.93-1.41 1.41" class="sun-ray sun-ray-2"/><path d="M20 12h2" class="sun-ray sun-ray-3"/><path d="m17.66 17.66 1.41 1.41" class="sun-ray sun-ray-4"/><path d="M12 20v2" class="sun-ray sun-ray-5"/><path d="m6.34 17.66-1.41 1.41" class="sun-ray sun-ray-6"/><path d="M2 12h2" class="sun-ray sun-ray-7"/><path d="m4.93 4.93 1.41 1.41" class="sun-ray sun-ray-8"/>`,
  moon: `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" class="moon-body"/>`,
  logOut: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" class="logout-door"/><polyline points="16 17 21 12 16 7" class="logout-arrow"/><line x1="21" x2="9" y1="12" y2="12" class="logout-stem"/>`,
  trash: `<g class="trash-lid"><path d="M3 6h18"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></g><path class="trash-bin" d="M19 8v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V8"/><line class="trash-line trash-line-1" x1="10" x2="10" y1="11" y2="17"/><line class="trash-line trash-line-2" x1="14" x2="14" y1="11" y2="17"/>`,
  delete: `<g class="trash-lid"><path d="M3 6h18"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></g><path class="trash-bin" d="M19 8v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V8"/><line class="trash-line trash-line-1" x1="10" x2="10" y1="11" y2="17"/><line class="trash-line trash-line-2" x1="14" x2="14" y1="11" y2="17"/>`,
  x: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  menu: `<line class="align-line align-line-1" x1="3" x2="21" y1="6" y2="6"/><line class="align-line align-line-2" x1="3" x2="15" y1="12" y2="12"/><line class="align-line align-line-3" x1="3" x2="17" y1="18" y2="18"/>`,
  alignLeft: `<line class="align-line align-line-1" x1="3" x2="21" y1="6" y2="6"/><line class="align-line align-line-2" x1="3" x2="15" y1="12" y2="12"/><line class="align-line align-line-3" x1="3" x2="17" y1="18" y2="18"/>`,

  // Status / feedback
  circleHelp: `<circle cx="12" cy="12" r="10"/><g class="circle-help-mark"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></g>`,
  check: `<polyline points="20 6 9 17 4 12"/>`,
  checkCircle: `<circle cx="12" cy="12" r="10"/><polyline points="8.5 12 11 14.5 15.5 9.5"/>`,
  xCircle: `<circle cx="12" cy="12" r="10"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/>`,
  alert: `<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>`,
  bug: `<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>`,
  info: `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>`,

  // Message actions (copy / upvote / downvote / refresh)
  thumbsUp: `<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z"/>`,
  thumbsDown: `<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z"/>`,
  copy: `<rect class="copy-front" width="14" height="14" x="8" y="8" rx="2" ry="2"/><path class="copy-back" d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
  refresh: `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,

  // Incognito / privacy
  incognito: `<g class="hat-group"><path d="m19 11-2.11-6.657a2 2 0 0 0-2.752-1.148l-1.276.61A2 2 0 0 1 12 4H8.5a2 2 0 0 0-1.925 1.456L5 11"/><path d="M2 11h20"/></g><g class="glasses-group"><path d="M14 18a2 2 0 0 0-4 0"/><circle cx="17" cy="18" r="3"/><circle cx="7" cy="18" r="3"/></g>`,

  // Tools & controls
  compass: `<path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/><circle cx="12" cy="12" r="10"/>`,
  slidersHorizontal: `<line x1="21" x2="14" y1="4" y2="4" class="slider-track-1-r"/><line x1="10" x2="3" y1="4" y2="4" class="slider-track-1-l"/><line x1="14" x2="14" y1="2" y2="6" class="slider-thumb slider-thumb-1"/><line x1="21" x2="12" y1="12" y2="12" class="slider-track-2-r"/><line x1="8" x2="3" y1="12" y2="12" class="slider-track-2-l"/><line x1="8" x2="8" y1="10" y2="14" class="slider-thumb slider-thumb-2"/><line x1="3" x2="12" y1="20" y2="20" class="slider-track-3-l"/><line x1="16" x2="21" y1="20" y2="20" class="slider-track-3-r"/><line x1="16" x2="16" y1="18" y2="22" class="slider-thumb slider-thumb-3"/>`,
  attachFile: `<path d="M6 7.90909V16C6 19.3137 8.68629 22 12 22V22C15.3137 22 18 19.3137 18 16V6C18 3.79086 16.2091 2 14 2V2C11.7909 2 10 3.79086 10 6V15.1818C10 16.2864 10.8954 17.1818 12 17.1818V17.1818C13.1046 17.1818 14 16.2864 14 15.1818V8" class="attach-clip"/>`,
  github: `<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>`,
  download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>`,
  loader: `<path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/>`,
  mic: `<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3" class="mic-capsule"/>`,
  audioLines: `<path d="M2 10v3" class="audio-bar audio-bar-edge"/><path d="M6 6v11" class="audio-bar audio-bar-1"/><path d="M10 3v18" class="audio-bar audio-bar-2"/><path d="M14 8v7" class="audio-bar audio-bar-3"/><path d="M18 5v13" class="audio-bar audio-bar-4"/><path d="M22 10v3" class="audio-bar audio-bar-edge"/>`,
  chevronDown: `<path d="m6 9 6 6 6-6"/>`,
  moreVertical: `<circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>`,
  pin: `<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4.76"/>`,
  pinOff: `<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4.76"/><line x1="2" x2="22" y1="2" y2="22"/>`,

  // Attachments menu
  image: `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>`,
  fileText: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`,
  camera: `<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>`,
};

const CONFIG_MAP = {
  imageSparkles: { viewBox: "0 0 14 14" },
  userProfile: { viewBox: "0 0 14 14" },
  preferences: { viewBox: "0 0 14 14" },
  planUsage: { viewBox: "0 0 14 14" },
  about: { viewBox: "0 0 24 24" },
  helpStudy: { viewBox: "0 0 14 14" },
};

export function icon(name, opts = {}) {
  if (name === "spike" || name === "mark") {
    const w = opts.width || 16;
    const h = opts.height || Math.round((w * 167) / 605);
    const cls = ["lucide-icon", `icon-${name}`, opts.className || opts.class || ""].filter(Boolean).join(" ");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="207.37 384.74 605.13 167.37" fill="currentColor" class="${cls}" aria-hidden="true">${MARK_PATHS}</svg>`;
  }
  const paths = PATHS[name];
  if (!paths) {
    console.warn(`icon('${name}') not found`);
    return "";
  }
  const cfg = CONFIG_MAP[name];
  if (cfg) {
    const w = opts.width || 16;
    const h = opts.height || w;
    const cls = ["lucide-icon", `icon-${name}`, opts.className || opts.class || ""].filter(Boolean).join(" ");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${cfg.viewBox}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${paths}</svg>`;
  }
  return SVG_BASE(paths, { name, ...opts });
}

export function formatDocIcon(fmt, { width = 18, height = 22 } = {}) {
  const f = (fmt || "md").toLowerCase();
  if (f === "pdf") {
    return `<svg width="${width}" height="${height}" viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 3a2 2 0 0 1 2-2h9.586a2 2 0 0 1 1.414.586l3.414 3.414A2 2 0 0 1 19 6.414V21a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3z" fill="#EF4444"/><path d="M13 1v4.5a1.5 1.5 0 0 0 1.5 1.5H19" fill="#FCA5A5"/><path d="M9.8 11.5c.3 1.3 1.3 2.9 2.5 3.4.4.2.8.2 1 .1.3-.2.3-.6.1-1-.4-.8-1.5-1.5-3.6-2.5zm0 0c-.8-1.2-1.3-2.6-1.1-3.2.1-.3.4-.5.7-.5.5 0 .8.8.4 2.2zm0 0c-1.3.8-3.1 1.6-4 1.7-.4.1-.6.3-.6.6 0 .4.4.7 1 .7 1 0 2.3-.9 3.6-2.5z" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (f === "docx" || f === "word" || f === "doc") {
    return `<svg width="${width}" height="${height}" viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 3a2 2 0 0 1 2-2h9.586a2 2 0 0 1 1.414.586l3.414 3.414A2 2 0 0 1 19 6.414V21a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3z" fill="#2563EB"/><path d="M13 1v4.5a1.5 1.5 0 0 0 1.5 1.5H19" fill="#93C5FD"/><text x="10" y="17.2" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="8.5" font-weight="800" text-anchor="middle">W</text></svg>`;
  }
  // Markdown default
  return `<svg width="${width}" height="${height}" viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 3a2 2 0 0 1 2-2h9.586a2 2 0 0 1 1.414.586l3.414 3.414A2 2 0 0 1 19 6.414V21a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3z" fill="#3B82F6"/><path d="M13 1v4.5a1.5 1.5 0 0 0 1.5 1.5H19" fill="#93C5FD"/><path d="M5.5 11h9M5.5 14.5h9M5.5 18h5.5" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}
