import { el, initialsFromName } from "../utils.js?v=52";

export function avatar(name, size = "md", imageUrl = null) {
  if (imageUrl) {
    return el("div", { class: `avatar ${size}`, "aria-hidden": "true" }, [
      el("img", {
        src: imageUrl,
        alt: name || "",
        referrerpolicy: "no-referrer",
        style: "width:100%;height:100%;border-radius:inherit;object-fit:cover;display:block",
        onerror: (e) => {
          // Fall back to initials if the image fails to load.
          const host = e.target.parentNode;
          if (host) {
            host.removeChild(e.target);
            host.textContent = initialsFromName(name);
          }
        },
      }),
    ]);
  }
  return el("div", { class: `avatar ${size}`, "aria-hidden": "true", text: initialsFromName(name) });
}
