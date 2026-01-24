/* index.js — OG Jewelry Frontpage
   - Mobile nav toggle + outside click + escape
   - Header elevate on scroll
   - Smooth anchor scrolling (respect reduced motion)
   - CTA email form (front-end only demo)
   - Year auto-update
   - Tiny “search” placeholder action
*/

(() => {
  "use strict";

  /* =========================
     Tiny helpers
  ========================= */
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const prefersReducedMotion = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  /* =========================
     Header elevate on scroll
  ========================= */
  const header = qs("[data-elevate-on-scroll]");
  const setHeaderState = () => {
    if (!header) return;
    const y = window.scrollY || 0;
    header.classList.toggle("is-elevated", y > 6);
  };

  /* =========================
     Mobile menu
  ========================= */
  const navToggle = qs(".nav-toggle");
  const mobileMenu = qs("#mobileMenu");

  const isMenuOpen = () => mobileMenu && !mobileMenu.hasAttribute("hidden");

  const openMenu = () => {
    if (!navToggle || !mobileMenu) return;

    mobileMenu.removeAttribute("hidden");
    navToggle.setAttribute("aria-expanded", "true");
    document.body.classList.add("menu-open");

    // Optional focus: first link
    const firstLink = qs(".mobile-menu a", mobileMenu);
    if (firstLink) firstLink.focus({ preventScroll: true });
  };

  const closeMenu = () => {
    if (!navToggle || !mobileMenu) return;

    mobileMenu.setAttribute("hidden", "");
    navToggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("menu-open");
  };

  const toggleMenu = () => {
    if (isMenuOpen()) closeMenu();
    else openMenu();
  };

  const closeMenuIfAnchorClicked = (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    // Close only if it's an in-page anchor or a normal link (mobile nav UX)
    closeMenu();
  };

  const handleOutsideClick = (e) => {
    if (!isMenuOpen()) return;
    const clickedToggle = navToggle && navToggle.contains(e.target);
    const clickedMenu = mobileMenu && mobileMenu.contains(e.target);
    if (!clickedToggle && !clickedMenu) closeMenu();
  };

  const handleEscape = (e) => {
    if (e.key !== "Escape") return;
    if (!isMenuOpen()) return;
    closeMenu();
    if (navToggle) navToggle.focus({ preventScroll: true });
  };

  /* =========================
     Smooth anchors (respect reduced motion)
  ========================= */
  const smoothScrollToId = (id) => {
    const el = qs(id);
    if (!el) return;

    const reduce = prefersReducedMotion();

    // Calculate offset for sticky header
    const headerH = header ? header.getBoundingClientRect().height : 0;
    const top = window.scrollY + el.getBoundingClientRect().top - headerH - 10;

    window.scrollTo({
      top: Math.max(0, top),
      behavior: reduce ? "auto" : "smooth",
    });
  };

  const interceptAnchorClicks = () => {
    document.addEventListener("click", (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;

      const href = a.getAttribute("href");
      // Allow skip link & empty href
      if (!href || href === "#") return;

      // If anchor is on the page, intercept for smooth scroll
      const target = qs(href);
      if (!target) return;

      e.preventDefault();
      closeMenu();
      smoothScrollToId(href);

      // Update URL hash without jumping
      history.pushState(null, "", href);
    });
  };

  // Handle initial hash on load
  const scrollToHashOnLoad = () => {
    const hash = window.location.hash;
    if (!hash || hash === "#") return;

    // Let layout settle first
    window.requestAnimationFrame(() => {
      // Avoid smooth on initial if reduced motion
      const reduce = prefersReducedMotion();
      if (reduce) {
        const el = qs(hash);
        if (el) el.scrollIntoView();
        return;
      }
      smoothScrollToId(hash);
    });
  };

  /* =========================
     CTA form (demo)
     - Keep static site safe: no network request by default.
     - Later: wire to Supabase / email service.
  ========================= */
  const initCtaForm = () => {
    const form = qs(".cta-form");
    if (!form) return;

    const input = qs('input[type="email"]', form);
    const button = qs('button[type="submit"]', form);

    const setBusy = (busy) => {
      if (!button) return;
      button.disabled = busy;
      button.setAttribute("aria-busy", busy ? "true" : "false");
      button.dataset.originalText = button.dataset.originalText || button.textContent;
      button.textContent = busy ? "Joining…" : button.dataset.originalText;
    };

    const showInlineMessage = (msg, type = "info") => {
      // Create once
      let note = qs(".cta-inline-msg", form);
      if (!note) {
        note = document.createElement("div");
        note.className = "cta-inline-msg";
        note.setAttribute("role", "status");
        form.appendChild(note);
      }
      note.dataset.type = type;
      note.textContent = msg;
    };

    form.addEventListener("submit", (e) => {
      e.preventDefault();

      const email = (input?.value || "").trim();
      if (!email) {
        showInlineMessage("Please enter your email.", "error");
        input?.focus();
        return;
      }

      // Basic client check (browser already validates type="email")
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showInlineMessage("That email doesn’t look right. Please check it.", "error");
        input?.focus();
        return;
      }

      // Simulate success (no backend yet)
      setBusy(true);

      const done = () => {
        setBusy(false);
        showInlineMessage("You’re in. Watch for private drops soon.", "success");
        if (input) input.value = "";
      };

      if (prefersReducedMotion()) {
        done();
      } else {
        window.setTimeout(done, 650);
      }
    });
  };

  /* =========================
     Year auto-update
  ========================= */
  const initYear = () => {
    const yearEl = qs("#year");
    if (!yearEl) return;
    yearEl.textContent = String(new Date().getFullYear());
  };

  /* =========================
     Optional: Hero video safety
     - If video fails to autoplay on some browsers, just keep poster.
  ========================= */
  const initHeroVideo = () => {
    const video = qs(".hero-video");
    if (!video) return;

    // If reduced motion, pause video to be respectful
    if (prefersReducedMotion()) {
      video.pause();
      video.removeAttribute("autoplay");
      return;
    }

    // Try to play; ignore errors silently (poster remains)
    const p = video.play?.();
    if (p && typeof p.then === "function") {
      p.catch(() => {
        // Autoplay might be blocked; no action needed.
      });
    }
  };

  /* =========================
     Search placeholder
  ========================= */
  const initSearchPlaceholder = () => {
    const btn = qs('[data-action="open-search"]');
    if (!btn) return;

    btn.addEventListener("click", () => {
      // Placeholder: replace later with a modal / command palette
      // Keep it subtle (no alerts if you prefer). We'll do a tiny toast.
      showToast("Search coming soon.");
    });
  };

  /* =========================
     Minimal toast (non-intrusive)
  ========================= */
  let toastTimer = null;
  const showToast = (text) => {
    let toast = qs(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }

    toast.textContent = text;
    toast.classList.add("show");

    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("show");
    }, 1800);
  };

  /* =========================
     Active nav link (nice polish)
  ========================= */
  const initActiveSectionObserver = () => {
    const links = qsa('.nav a[href^="#"], .mobile-menu a[href^="#"]');
    const sections = ["#collections", "#featured", "#story", "#contact"]
      .map((id) => qs(id))
      .filter(Boolean);

    if (!("IntersectionObserver" in window) || sections.length === 0 || links.length === 0) return;

    const byHref = new Map();
    links.forEach((a) => byHref.set(a.getAttribute("href"), a));

    const setActive = (href) => {
      links.forEach((a) => a.classList.toggle("is-active", a.getAttribute("href") === href));
    };

    const io = new IntersectionObserver(
      (entries) => {
        // Choose the most visible entry
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        if (!visible) return;

        const id = "#" + visible.target.id;
        if (byHref.has(id)) setActive(id);
      },
      {
        root: null,
        // Trigger when section is meaningfully in view
        threshold: [0.2, 0.35, 0.5, 0.65],
        rootMargin: "-10% 0px -65% 0px",
      }
    );

    sections.forEach((s) => io.observe(s));
  };

  /* =========================
     Boot
  ========================= */
  const init = () => {
    // Header scroll state
    setHeaderState();
    window.addEventListener("scroll", setHeaderState, { passive: true });

    // Mobile nav
    if (navToggle && mobileMenu) {
      navToggle.addEventListener("click", toggleMenu);
      mobileMenu.addEventListener("click", closeMenuIfAnchorClicked);
      document.addEventListener("click", handleOutsideClick);
      document.addEventListener("keydown", handleEscape);
    }

    // Anchors
    interceptAnchorClicks();
    scrollToHashOnLoad();

    // CTA
    initCtaForm();

    // Footer year
    initYear();

    // Hero video
    initHeroVideo();

    // Search placeholder
    initSearchPlaceholder();

    // Active section observer
    initActiveSectionObserver();
  };

  // Run after DOM is ready (defer already helps, but safe)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
