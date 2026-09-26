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
  share: `<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/>`,
  externalLink: `<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/>`,`
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
  pin: `<path d="M0 0 C4.42 0.44 6.91 3.45 9.89 6.43 C10.45 6.97 11 7.51 11.57 8.07 C12.73 9.22 13.88 10.38 15.04 11.54 C16.81 13.31 18.6 15.06 20.4 16.81 C21.52 17.93 22.65 19.05 23.77 20.18 C24.31 20.7 24.85 21.22 25.4 21.76 C28.98 25.4 28.98 25.4 29.07 28.17 C27.71 30.49 26.28 31.62 24.07 33.16 C23.27 33.73 22.48 34.29 21.66 34.88 C20.82 35.45 19.99 36.03 19.12 36.62 C18.3 37.21 17.47 37.8 16.61 38.4 C13.43 40.64 10.24 42.84 7 45 C6.56 47.36 6.56 47.36 6.56 50.06 C5.99 58.68 2.79 64.73 -3 71 C-5.93 69.68 -7.99 68.25 -10.23 65.96 C-10.81 65.38 -11.38 64.8 -11.97 64.2 C-12.56 63.6 -13.15 63 -13.75 62.38 C-14.35 61.76 -14.95 61.15 -15.57 60.52 C-17.05 59.02 -18.53 57.51 -20 56 C-24.04 59.32 -27.79 62.74 -31.41 66.52 C-32.17 67.32 -32.94 68.11 -33.72 68.93 C-35.3 70.57 -36.86 72.23 -38.42 73.89 C-39.18 74.68 -39.94 75.46 -40.72 76.27 C-41.4 76.99 -42.08 77.71 -42.78 78.44 C-45.65 80.45 -47.57 80.29 -51 80 C-51.5 75.95 -51.32 74.42 -48.8 71.12 C-47.8 70.12 -46.78 69.13 -45.75 68.16 C-45.22 67.64 -44.68 67.12 -44.14 66.58 C-42.44 64.91 -40.72 63.27 -39 61.62 C-37.84 60.5 -36.69 59.37 -35.53 58.24 C-32.7 55.48 -29.86 52.73 -27 50 C-30.48 45.86 -34.02 41.86 -37.88 38.06 C-38.66 37.29 -39.44 36.52 -40.24 35.72 C-40.82 35.15 -41.4 34.59 -42 34 C-39.66 28.61 -35.48 26.13 -30.25 23.75 C-27 23 -27 23 -24.53 23.16 C-21.28 23.27 -19.07 23.12 -16 22 C-12.46 18.23 -9.78 14.13 -7.09 9.74 C-5.64 7.43 -4.03 5.28 -2.38 3.12 C-1.59 2.09 -0.81 1.06 0 0 Z M1 11 C-0.43 12.7 -0.43 12.7 -1.86 14.9 C-2.42 15.71 -2.98 16.52 -3.55 17.35 C-4.72 19.07 -5.88 20.79 -7.04 22.51 C-7.6 23.32 -8.16 24.13 -8.74 24.96 C-9.5 26.09 -9.5 26.09 -10.27 27.23 C-13.84 30.88 -19.75 30.27 -24.6 30.62 C-27.09 31.01 -28.82 31.76 -31 33 C-29.42 36.88 -26.77 39.52 -23.84 42.42 C-23.09 43.18 -23.09 43.18 -22.32 43.95 C-21.26 45.01 -20.2 46.07 -19.13 47.13 C-17.5 48.75 -15.88 50.38 -14.25 52.02 C-13.22 53.05 -12.19 54.08 -11.16 55.11 C-10.43 55.85 -10.43 55.85 -9.68 56.6 C-7.29 59.24 -7.29 59.24 -4 60 C-1.86 55.19 -0.85 52.35 -1.62 47.12 C-1.73 44.59 -1.73 44.59 -1 42 C2.91 38.02 7.33 35.02 12 32 C13.14 31.24 14.29 30.48 15.43 29.71 C16.28 29.15 17.13 28.58 18 28 C16.69 25.1 15.27 23.02 13.03 20.77 C12.46 20.19 11.89 19.62 11.3 19.03 C10.71 18.44 10.11 17.85 9.5 17.25 C8.91 16.65 8.31 16.05 7.7 15.43 C7.13 14.86 6.56 14.29 5.97 13.7 C5.45 13.18 4.93 12.66 4.39 12.13 C3.04 10.79 3.04 10.79 1 11 Z" fill="currentColor" transform="translate(63,8)"/>`,
  pinOff: `<path d="M0 0 C3.01 0.11 4.08 1.08 6.3 3.13 C7.13 4.05 7.96 4.97 8.82 5.91 C9.75 6.91 10.69 7.91 11.63 8.91 C13.1 10.48 14.56 12.06 15.99 13.66 C22.6 21.2 22.6 21.2 31.88 24.09 C35.54 23.69 37.63 23.01 40.05 20.22 C40.84 19 41.6 17.76 42.31 16.5 C43.13 15.22 43.94 13.93 44.76 12.65 C45.14 12.02 45.52 11.4 45.91 10.75 C47.35 8.44 48.96 6.28 50.62 4.12 C51.41 3.09 52.19 2.06 53 1 C57.42 1.44 59.91 4.45 62.89 7.43 C63.72 8.24 63.72 8.24 64.57 9.07 C65.73 10.22 66.88 11.38 68.04 12.54 C69.81 14.31 71.6 16.06 73.4 17.81 C74.52 18.93 75.65 20.05 76.77 21.18 C77.31 21.7 77.85 22.22 78.4 22.76 C81.98 26.4 81.98 26.4 82.07 29.17 C80.71 31.49 79.28 32.62 77.07 34.16 C76.27 34.73 75.48 35.29 74.66 35.88 C73.82 36.45 72.99 37.03 72.12 37.62 C71.3 38.21 70.47 38.8 69.61 39.4 C66.43 41.64 63.24 43.84 60 46 C58.77 49.84 58.97 53.13 60 57 C63.33 61.56 67.37 65.19 71.56 68.94 C73.22 70.45 74.88 71.98 76.52 73.51 C77.99 74.9 79.5 76.25 81 77.61 C83 80 83 80 82.93 82.19 C82 84 82 84 80 86 C76.59 85.68 74.89 84.27 72.51 81.91 C71.84 81.25 71.17 80.59 70.48 79.91 C69.75 79.18 69.03 78.45 68.28 77.7 C67.51 76.93 66.73 76.17 65.94 75.38 C63.38 72.85 60.84 70.31 58.29 67.76 C56.53 66 54.76 64.24 52.99 62.48 C49.28 58.79 45.59 55.09 41.89 51.39 C37.62 47.11 33.33 42.84 29.03 38.59 C24.9 34.49 20.78 30.38 16.67 26.26 C14.92 24.51 13.16 22.77 11.4 21.02 C8.95 18.59 6.51 16.14 4.07 13.69 C3.34 12.97 2.6 12.24 1.84 11.5 C1.19 10.83 0.53 10.16 -0.15 9.47 C-0.73 8.9 -1.3 8.32 -1.9 7.72 C-3 6 -3 6 -2.8 3.91 C-2 2 -2 2 0 0 Z M54 12 C52.57 13.7 52.57 13.7 51.14 15.9 C50.58 16.71 50.02 17.52 49.45 18.35 C48.28 20.07 47.12 21.79 45.96 23.51 C45.4 24.32 44.84 25.13 44.26 25.96 C43.76 26.71 43.25 27.46 42.73 28.23 C40.56 30.45 39.02 30.61 36 31 C35.34 31.33 34.68 31.66 34 32 C39.61 37.61 45.22 43.22 51 49 C52.13 47.01 52.13 47.01 52.31 44.58 C53.18 41.32 54.29 40.57 57.04 38.67 C57.84 38.1 58.65 37.53 59.49 36.94 C60.34 36.36 61.19 35.78 62.06 35.19 C63.34 34.29 63.34 34.29 64.65 33.38 C66.76 31.9 68.87 30.45 71 29 C69.69 26.1 68.27 24.02 66.03 21.77 C65.46 21.19 64.89 20.62 64.3 20.03 C63.41 19.15 63.41 19.15 62.5 18.25 C61.61 17.35 61.61 17.35 60.7 16.43 C60.13 15.86 59.56 15.29 58.97 14.7 C58.45 14.18 57.93 13.66 57.39 13.13 C56.04 11.79 56.04 11.79 54 12 Z" fill="currentColor" transform="translate(10,7)"/><path d="M0 0 C3.5 0.45 5.21 1.83 7.68 4.26 C8.39 4.95 9.09 5.64 9.82 6.35 C10.94 7.47 10.94 7.47 12.08 8.61 C13.24 9.76 13.24 9.76 14.43 10.93 C16.06 12.56 17.69 14.18 19.31 15.81 C21.81 18.31 24.32 20.78 26.84 23.26 C28.42 24.83 30 26.41 31.58 27.99 C32.34 28.73 33.1 29.47 33.88 30.24 C34.91 31.28 34.91 31.28 35.96 32.35 C36.58 32.96 37.19 33.57 37.82 34.2 C39 36 39 36 38.94 38.1 C38 40 38 40 34 42 C29.05 37.05 24.1 32.1 19 27 C13.06 32.09 13.06 32.09 7.59 37.52 C6.83 38.32 6.06 39.11 5.28 39.93 C3.7 41.57 2.14 43.23 0.58 44.89 C-0.18 45.68 -0.94 46.46 -1.72 47.27 C-2.4 47.99 -3.08 48.71 -3.78 49.44 C-6.65 51.45 -8.57 51.29 -12 51 C-12.5 46.95 -12.32 45.42 -9.8 42.12 C-8.8 41.12 -7.78 40.13 -6.75 39.16 C-6.22 38.64 -5.68 38.12 -5.14 37.58 C-3.44 35.91 -1.72 34.27 0 32.62 C1.16 31.5 2.31 30.37 3.47 29.24 C6.3 26.48 9.14 23.73 12 21 C8.52 16.86 4.98 12.86 1.12 9.06 C0.34 8.29 -0.44 7.52 -1.24 6.72 C-1.82 6.15 -2.4 5.59 -3 5 C-1.12 1.12 -1.12 1.12 0 0 Z" fill="currentColor" transform="translate(24,37)"/>`,

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
  pin: { viewBox: "2.38 2.38 95.24 95.24", fill: true },
  pinOff: { viewBox: "0 0 100 100", fill: true },
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
    if (cfg.fill) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${cfg.viewBox}" fill="currentColor" class="${cls}" aria-hidden="true">${paths}</svg>`;
    }
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
