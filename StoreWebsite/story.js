(function () {
  const hero = document.querySelector("[data-story-carousel]");
  if (!hero) return;

  const copies = Array.from(hero.querySelectorAll("[data-story-copy]"));
  const indicators = Array.from(hero.querySelectorAll("[data-story-indicator]"));
  const media = hero.querySelector(".story-hero-media");
  const mediaVideo = hero.querySelector("video");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const autoplayMs = 7800;

  let activeIndex = 0;
  let timer = null;
  let pointerStartX = null;

  function ensureVideoPlayback() {
    if (!mediaVideo) return;
    const playPromise = mediaVideo.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        media?.classList.add("is-fallback");
      });
    }
  }

  mediaVideo?.addEventListener("error", () => {
    media?.classList.add("is-fallback");
  });

  function render(index) {
    activeIndex = (index + copies.length) % copies.length;

    copies.forEach((copy, copyIndex) => {
      const isActive = copyIndex === activeIndex;
      copy.classList.toggle("is-active", isActive);
      copy.setAttribute("aria-hidden", String(!isActive));
    });

    indicators.forEach((indicator, indicatorIndex) => {
      const isActive = indicatorIndex === activeIndex;
      indicator.classList.toggle("is-active", isActive);
      indicator.setAttribute("aria-pressed", String(isActive));
    });

    ensureVideoPlayback();
  }

  function stopAutoplay() {
    if (timer) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function startAutoplay() {
    stopAutoplay();
    if (reducedMotion || copies.length < 2) return;

    timer = window.setInterval(() => {
      render(activeIndex + 1);
    }, autoplayMs);
  }

  function restartAutoplay() {
    startAutoplay();
  }

  indicators.forEach((indicator, index) => {
    indicator.addEventListener("click", () => {
      render(index);
      restartAutoplay();
    });
  });

  hero.addEventListener("pointerdown", (event) => {
    pointerStartX = event.clientX;
    stopAutoplay();
  });

  hero.addEventListener("pointerup", (event) => {
    if (pointerStartX == null) return;

    const delta = event.clientX - pointerStartX;
    pointerStartX = null;

    if (Math.abs(delta) < 40) {
      restartAutoplay();
      return;
    }

    render(delta > 0 ? activeIndex - 1 : activeIndex + 1);
    restartAutoplay();
  });

  hero.addEventListener("pointercancel", () => {
    pointerStartX = null;
    restartAutoplay();
  });

  hero.addEventListener("mouseenter", stopAutoplay);
  hero.addEventListener("mouseleave", restartAutoplay);
  hero.addEventListener("focusin", stopAutoplay);
  hero.addEventListener("focusout", restartAutoplay);

  hero.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      render(activeIndex - 1);
      restartAutoplay();
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      render(activeIndex + 1);
      restartAutoplay();
    }
  });

  render(0);
  ensureVideoPlayback();
  startAutoplay();
})();
