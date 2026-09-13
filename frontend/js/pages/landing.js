import { $, el, clear } from "../utils.js?v=30";
import { icon } from "../icons.js?v=30";
import { logo } from "../components/logo.js?v=32";
import { toast } from "../components/toast.js?v=58";
import { signInWithGoogle, signInWithGithub, isConfigured } from "../auth.js?v=31";
import { navigate } from "../router.js?v=31";
import { tearDownShell } from "../app-shell.js?v=72";
import { getThemePref, setThemePref } from "../prefs.js?v=32";


export async function renderLanding() {
  tearDownShell();
  // Landing page strictly uses light theme
  document.documentElement.dataset.theme = "light";
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute("content", "#faf9f5");

  const root = $("#app");
  clear(root);
  root.className = "app-root";

  const main = el("div", { class: "landing" });

  let signingIn = false;

  const startSignIn = async () => {
    if (signingIn) return;
    if (!isConfigured()) {
      toast("Supabase isn't configured", { tone: "error", duration: 5500 });
      navigate("#/app/settings");
      return;
    }
    signingIn = true;
    try {
      await signInWithGoogle();
      // Supabase performs the OAuth redirect; control returns here only if it
      // didn't, so re-enable the button.
    } catch (err) {
      toast(err.message || "Sign-in failed", { tone: "error" });
    } finally {
      signingIn = false;
    }
  };

  const startGithubSignIn = async () => {
    if (signingIn) return;
    if (!isConfigured()) {
      toast("Supabase isn't configured", { tone: "error", duration: 5500 });
      navigate("#/app/settings");
      return;
    }
    signingIn = true;
    try {
      await signInWithGithub();
    } catch (err) {
      toast(err.message || "Sign-in failed", { tone: "error" });
    } finally {
      signingIn = false;
    }
  };

  // ---------- Top nav ----------
  main.append(
    el("header", { class: "landing-nav" }, [
      el("div", { class: "landing-nav-inner" }, [
        el("div", { class: "landing-nav-bar" }, [
          logo({ size: "md" }),
          el("nav", { class: "landing-nav-links" }),
          el("div", { class: "landing-nav-actions" }, [
            el("button", {
              type: "button",
              class: "btn sm nav-action-btn",
              onclick: startSignIn,
              text: "Try BMO",
            }),
          ]),
        ]),
      ]),
    ])
  );

  // ---------- Hero ----------
  main.append(
    el("section", { class: "hero" }, [
      el("div", { class: "hero-inner" }, [
        el("div", { class: "hero-grid" }, [
          el("div", {}, [
            el("h1", { class: "hero-title", html:
              `<span class="line">Your private</span><span class="line"><span class="accent">AI</span> conversation lab.</span>`
            }),
            el("p", { class: "hero-desc",
              text: "BMO is a streaming AI chat workspace. Sign in with Google, pick a mode per chat, attach images, and talk to it by voice."
            }),
            el("div", { class: "hero-actions" }, [
              el("button", {
                type: "button",
                class: "btn google lg",
                onclick: startSignIn,
                style: "gap: 12px; border-radius: 8px;",
                html: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.16v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.16C1.43 8.55 1 10.22 1 12s.43 3.45 1.16 4.93l3.68-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.16 7.07l3.68 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg><span>Continue with Google</span>`,
              }),
              el("button", {
                type: "button",
                class: "btn google lg",
                onclick: startGithubSignIn,
                style: "gap: 12px; border-radius: 8px;",
                html: `${icon("github", { width: 18, height: 18 })}<span>Continue with GitHub</span>`,
              }),
            ]),
          ]),
          heroPreview(),
        ]),
      ]),
    ])
  );

  // Removed lower sections to keep the landing page a simple one-page hero component.

  root.append(main);

  // Scroll-reveal for sections + cards.
  const reveals = main.querySelectorAll(
    ".section-head, .cta, .split > div:first-child"
  );
  reveals.forEach((node) => node.classList.add("reveal"));

  const staggerContainers = main.querySelectorAll(
    ".feature-grid, .architecture-grid, .roadmap-grid"
  );
  staggerContainers.forEach((node) => node.classList.add("reveal-stagger"));

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      }
    }, { threshold: 0.15, rootMargin: "0px 0px -30% 0px" });
    
    reveals.forEach((node) => io.observe(node));
    staggerContainers.forEach((node) => io.observe(node));
  } else {
    reveals.forEach((node) => node.classList.add("is-visible"));
    staggerContainers.forEach((node) => node.classList.add("is-visible"));
  }
}


function heroPreview() {
  return el("video", {
    class: "hero-preview",
    src: "/assets/hero.mp4",
    autoplay: true,
    loop: true,
    muted: true,
    playsinline: true,
    style: "object-fit: cover; padding: 0; border: none;"
  });
}
