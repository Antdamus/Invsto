(function () {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const revealTargets = Array.from(document.querySelectorAll(".reveal-section"));
  const hero = document.querySelector(".hero-arrival");
  const testimonialStage = document.getElementById("testimonialStage");
  const testimonialFeatureMedia = document.getElementById("testimonialFeatureMedia");
  const testimonialCopyPanel = document.getElementById("testimonialCopyPanel");
  const testimonialStatus = document.getElementById("testimonialStatus");
  const testimonialPrevBtn = document.getElementById("testimonialPrev");
  const testimonialNextBtn = document.getElementById("testimonialNext");

  const SUPABASE_PROJECT_URL =
    window.SUPABASE_URL || "https://byhytmarmigalvawkedi.supabase.co";

  const TESTIMONIALS_FN_URL = `${SUPABASE_PROJECT_URL}/functions/v1/storefront-testimonials`;
  const EBAY_LIVE_FN_URL =
    `${SUPABASE_PROJECT_URL}/functions/v1/ebay-live-events`;

  /*
    TEMPORARY SWITCH:
    Keep this true while your eBay developer approval is pending.
    Later, change it to false when you want to fetch from Supabase / edge function.
  */
  const USE_PLACEHOLDER_TESTIMONIALS = false;

  /*
    These placeholders are shaped like the final Supabase records
    so your UI logic can stay almost identical later.
    Replace image URLs below with your real local/site/supabase image URLs if needed.
  */
  const PLACEHOLDER_TESTIMONIALS = [
    {
      id: "placeholder-1",
      source_review_id: "placeholder-1",
      review_text:
        "Your pricing is fair and competitive, and it really reflects that you care about giving customers value without sacrificing quality. ",
      source_buyer_display: "Verified eBay buyer",
      review_photo_url: null,
      fallback_item_image_url: "review-1.jpg",
      item_title: "Rolex",
      
    },
    {
      id: "placeholder-2",
      source_review_id: "placeholder-2",
      review_text:
        "A great jewelry store by The best of the best personalized service, expert craftsmanship, and a welcoming atmosphere.",
      source_buyer_display: "Recent eBay feedback",
      review_photo_url: null,
      fallback_item_image_url: "review-2.jpg",
      item_title: "Silver bracelet",
      
    },
    {
      id: "placeholder-3",
      source_review_id: "placeholder-3",
      review_text:
        "I love this Jewelry store and the man behind it all OG the one and only!!!",
      source_buyer_display: "Verified eBay buyer",
      review_photo_url: null,
      fallback_item_image_url: "review-3.jpg",
      item_title: "Solid Silver Chain",
      
    },
    {
      id: "placeholder-4",
      source_review_id: "placeholder-4",
      review_text:
        "Item was exactly as advertised. Went through ebay authentication with no issues and was promptly received. Would definitely buy again.",
      source_buyer_display: "Collector review",
      review_photo_url: null,
      fallback_item_image_url: "review-4.jpg",
      item_title: "14K GOLD MIAMI CUBAN 24 INCH",
    
    },
    {
      id: "placeholder-5",
      source_review_id: "placeholder-5",
      review_text:
        "I love this guy!!! His Ebay Lives are AWESOME!!!! You have to watch at least one of his Events and you will be HOOKED!!!",
      source_buyer_display: "Verified eBay buyer",
      review_photo_url: null,
      fallback_item_image_url: "review-5.jpg",
      item_title: "Moissanite Stud Earrings",
      review_date: "2026-03-10T00:00:00Z",
    },
  ];

  const FALLBACK_TESTIMONIALS = PLACEHOLDER_TESTIMONIALS.map(normalizeTestimonialRecord);
  const TESTIMONIAL_AUTOPLAY_MS = 5000;

  let testimonialItems = [...FALLBACK_TESTIMONIALS];
  let activeTestimonialIndex = 0;
  let testimonialPointerStartX = null;
  let testimonialsUsingFallback = true;
  let testimonialAutoplayTimer = null;

  const EBAY_LIVE_FALLBACK_EVENTS = [
    {
      title: "Fine Jewelry and Luxury Watches Live",
      seller: "ogjewelers",
      dateLabel: "Mar 20 8:30 PM",
      url: "https://www.ebay.com/ebaylive/sellers/lertro4xscs",
      startsAtIso: "2026-03-21T00:30:00.000Z",
      timezone: "America/New_York",
      status: "upcoming",
    },
    {
      title: "Custom Pieces, Diamonds, and Collector Finds",
      seller: "ogjewelers",
      dateLabel: "Mar 22 6:00 PM",
      url: "https://www.ebay.com/ebaylive/sellers/lertro4xscs",
      startsAtIso: "2026-03-22T22:00:00.000Z",
      timezone: "America/New_York",
      status: "upcoming",
    },
  ];

  function markReady() {
    window.requestAnimationFrame(() => {
      document.body.classList.add("is-ready");
    });
  }

  function normalizeTestimonialRecord(record) {
    const quote = String(record?.review_text || "").trim();
    return {
      sourceReviewId: String(record?.source_review_id || record?.id || crypto.randomUUID()),
      quote: quote || "A trusted OG buyer shared positive feedback.",
      source: String(record?.source_buyer_display || "Verified eBay buyer"),
      note: String(
        record?.review_date
          ? `Recent verified feedback from ${formatShortDate(record.review_date)}.`
          : "Recent verified eBay feedback."
      ),
      itemTitle: String(record?.item_title || "Featured OG piece"),
      imageUrl: String(
        record?.review_photo_url ||
          record?.fallback_item_image_url ||
          "OG-Jewelers.webp"
      ),
      hasPhoto: Boolean(record?.review_photo_url),
    };
  }

  function formatShortDate(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "recently";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(parsed);
  }

  function renderTestimonials() {
    if (!testimonialStage || !testimonialFeatureMedia || !testimonialCopyPanel || !testimonialStatus) return;

    if (!testimonialItems.length) {
      testimonialStage.classList.add("is-empty");
      testimonialFeatureMedia.innerHTML = "";
      testimonialCopyPanel.innerHTML = "";
      testimonialStatus.textContent = "No approved reviews are available right now.";
      return;
    }

    const active = testimonialItems[activeTestimonialIndex];

    testimonialStage.classList.remove("is-empty");
    testimonialFeatureMedia.innerHTML = `
      <img
        src="${ebayEsc(active.imageUrl)}"
        alt="${ebayEsc(active.itemTitle)}"
        loading="lazy"
      />
    `;

    testimonialCopyPanel.innerHTML = `
      <span class="testimonial-rating">5-star feedback</span>
      <p class="testimonial-quote">"${ebayEsc(active.quote)}"</p>
      <span class="testimonial-source">${ebayEsc(active.source)}</span>
      <div class="testimonial-note">${ebayEsc(active.note)}</div>
      <span class="testimonial-item">${ebayEsc(active.itemTitle)}</span>
    `;

    testimonialStatus.textContent = testimonialsUsingFallback
      ? ""
      : "";
  }

  function moveTestimonial(direction) {
    if (!testimonialItems.length) return;
    activeTestimonialIndex =
      (activeTestimonialIndex + direction + testimonialItems.length) %
      testimonialItems.length;
    renderTestimonials();
  }

  function stopTestimonialAutoplay() {
    if (testimonialAutoplayTimer) {
      window.clearInterval(testimonialAutoplayTimer);
      testimonialAutoplayTimer = null;
    }
  }

  function startTestimonialAutoplay() {
    stopTestimonialAutoplay();
    if (prefersReducedMotion || testimonialItems.length < 2) return;

    testimonialAutoplayTimer = window.setInterval(() => {
      moveTestimonial(1);
    }, TESTIMONIAL_AUTOPLAY_MS);
  }

  function restartTestimonialAutoplay() {
    startTestimonialAutoplay();
  }

  async function loadTestimonials() {
    if (!testimonialStatus) return;

    if (USE_PLACEHOLDER_TESTIMONIALS) {
      testimonialItems = [...FALLBACK_TESTIMONIALS];
      testimonialsUsingFallback = true;
      activeTestimonialIndex = 0;
      renderTestimonials();
      return;
    }

    testimonialStatus.textContent = "Loading approved reviews...";

    try {
      const res = await fetch(`${TESTIMONIALS_FN_URL}?limit=7`, {
        method: "GET",
        cache: "no-store",
      });

      if (!res.ok) {
        throw new Error(`testimonial_fetch_failed (${res.status})`);
      }

      const data = await res.json();
      const items = Array.isArray(data?.items)
        ? data.items.map(normalizeTestimonialRecord)
        : [];

      testimonialItems = items.length ? items : [...FALLBACK_TESTIMONIALS];
      testimonialsUsingFallback = !items.length;
      activeTestimonialIndex = 0;
      renderTestimonials();
    } catch (error) {
      console.error("Failed to load testimonials:", error);
      testimonialItems = [...FALLBACK_TESTIMONIALS];
      testimonialsUsingFallback = true;
      activeTestimonialIndex = 0;
      renderTestimonials();
    }
  }

  function setupTestimonials() {
    if (!testimonialStage) return;

    renderTestimonials();

    testimonialPrevBtn?.addEventListener("click", () => {
      moveTestimonial(-1);
      restartTestimonialAutoplay();
    });

    testimonialNextBtn?.addEventListener("click", () => {
      moveTestimonial(1);
      restartTestimonialAutoplay();
    });

    testimonialStage.addEventListener("pointerdown", (event) => {
      testimonialPointerStartX = event.clientX;
      stopTestimonialAutoplay();
    });

    testimonialStage.addEventListener("pointerup", (event) => {
      if (testimonialPointerStartX == null) return;
      const delta = event.clientX - testimonialPointerStartX;
      testimonialPointerStartX = null;

      if (Math.abs(delta) < 40) return;
      moveTestimonial(delta > 0 ? -1 : 1);
      restartTestimonialAutoplay();
    });

    testimonialStage.addEventListener("pointercancel", () => {
      testimonialPointerStartX = null;
      restartTestimonialAutoplay();
    });

    testimonialStage.addEventListener("mouseenter", stopTestimonialAutoplay);
    testimonialStage.addEventListener("mouseleave", restartTestimonialAutoplay);
    testimonialStage.addEventListener("focusin", stopTestimonialAutoplay);
    testimonialStage.addEventListener("focusout", restartTestimonialAutoplay);

    window.addEventListener("keydown", (event) => {
      if (
        !testimonialStage.contains(document.activeElement) &&
        !testimonialPrevBtn?.matches(":focus") &&
        !testimonialNextBtn?.matches(":focus")
      ) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveTestimonial(-1);
        restartTestimonialAutoplay();
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveTestimonial(1);
        restartTestimonialAutoplay();
      }
    });

    loadTestimonials();
    startTestimonialAutoplay();
  }

  function setupSectionReveal() {
    if (prefersReducedMotion || !("IntersectionObserver" in window)) {
      revealTargets.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.16 }
    );

    revealTargets.forEach((el) => observer.observe(el));
  }

  function setupHeroParallax() {
    if (prefersReducedMotion || !hero) return;

    const video = hero.querySelector(".hero-video");
    if (!video) return;

    const update = () => {
      const rect = hero.getBoundingClientRect();
      const viewportHeight = window.innerHeight || 1;
      const progress = Math.max(-1, Math.min(1, rect.top / viewportHeight));
      const translateY = progress * -18;
      video.style.transform = `scale(1.08) translate3d(0, ${translateY}px, 0)`;
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
  }

  function ebayEsc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function parseSortableEbayDate(eventOrLabel) {
    if (eventOrLabel && typeof eventOrLabel === "object") {
      if (eventOrLabel.startsAtIso) {
        const isoDate = new Date(eventOrLabel.startsAtIso);
        if (!Number.isNaN(isoDate.getTime())) return isoDate;
      }

      eventOrLabel = eventOrLabel.dateLabel || "";
    }

    const raw = String(eventOrLabel || "").trim();
    if (!raw) return null;

    const match = raw.match(
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i
    );
    if (!match) return null;

    const [, monRaw, dayStr, hourStr, minStr, ampm] = match;
    const monthMap = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };

    const month = monthMap[monRaw.toLowerCase()];
    if (month == null) return null;

    let hour = Number(hourStr);
    const minute = Number(minStr);
    const day = Number(dayStr);

    if (ampm.toUpperCase() === "PM" && hour !== 12) hour += 12;
    if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;

    const now = new Date();
    let year = now.getFullYear();
    let dt = new Date(year, month, day, hour, minute, 0, 0);

    const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
    if (now.getTime() - dt.getTime() > sixtyDaysMs) {
      year += 1;
      dt = new Date(year, month, day, hour, minute, 0, 0);
    }

    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function isEventLiveNow(event) {
    const eventDate = parseSortableEbayDate(event);
    if (!eventDate) return false;

    const now = new Date();
    const diff = now.getTime() - eventDate.getTime();
    return diff >= 0 && diff <= 2 * 60 * 60 * 1000;
  }

  function formatDisplayDate(event) {
    const parsed = parseSortableEbayDate(event);
    if (!parsed) return String(event?.dateLabel || "");

    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(parsed);
  }

  function formatTimeZone(event) {
    const parsed = parseSortableEbayDate(event);
    if (!parsed) return "Scheduled";

    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    })
      .format(parsed)
      .replace(/^[^,]*,\s*/, "");
  }

  function getCountdownLabel(event) {
    const parsed = parseSortableEbayDate(event);
    if (!parsed) return "Scheduled soon";

    const diff = parsed.getTime() - Date.now();
    if (diff <= 0) return isEventLiveNow(event) ? "Live now" : "Starting soon";

    const totalMinutes = Math.floor(diff / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function getThemeFromTitle(title) {
    const value = String(title || "").toLowerCase();
    if (/(watch|rolex|datejust|ap|audemars|cartier|timepiece)/.test(value))
      return "watch";
    if (/(diamond|moissanite|gem|ring|tennis)/.test(value)) return "diamond";
    if (/(gold|chain|bracelet|14k|10k|solid gold)/.test(value)) return "gold";
    if (/(custom|one of one|bespoke)/.test(value)) return "custom";
    return "og";
  }

  function getThemeLabel(theme) {
    switch (theme) {
      case "watch":
        return "Luxury watch focus";
      case "diamond":
        return "Diamond and stone edit";
      case "gold":
        return "Gold and signature links";
      case "custom":
        return "Custom and standout pieces";
      default:
        return "OG live preview";
    }
  }

  function getEventStatusLabel(event) {
    if (event.status === "live" || isEventLiveNow(event)) return "Live on eBay";
    return "Upcoming on eBay Live";
  }

  function getEventSummary(event, theme) {
    const seller = event?.seller ? `Hosted by ${event.seller}` : "Hosted by OG Jewelers";
    switch (theme) {
      case "watch":
        return `${seller} with luxury watches, sharp timing, and collector-ready pieces.`;
      case "diamond":
        return `${seller} with diamonds, fine jewelry, and strong live-show momentum.`;
      case "gold":
        return `${seller} with gold staples, standout links, and everyday heavy hitters.`;
      case "custom":
        return `${seller} with custom work, rare finds, and one-on-one live energy.`;
      default:
        return `${seller} with fine jewelry, premium sourcing, and real-time OG auction energy.`;
    }
  }

  function filterAndSortUpcomingEvents(events) {
    const now = new Date();

    const mapped = (Array.isArray(events) ? events : []).map((event) => {
      const parsedDate = parseSortableEbayDate(event);
      const liveNow = event?.status === "live" || isEventLiveNow(event);

      return {
        ...event,
        __parsedDate: parsedDate,
        __isLiveNow: liveNow,
      };
    });

    const filtered = mapped.filter((event) => {
      if (event.__isLiveNow) return true;
      if (!event.__parsedDate) return false;
      return event.__parsedDate.getTime() >= now.getTime();
    });

    filtered.sort((a, b) => {
      if (a.__isLiveNow && !b.__isLiveNow) return -1;
      if (!a.__isLiveNow && b.__isLiveNow) return 1;

      const aTime = a.__parsedDate
        ? a.__parsedDate.getTime()
        : Number.MAX_SAFE_INTEGER;
      const bTime = b.__parsedDate
        ? b.__parsedDate.getTime()
        : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });

    return filtered;
  }

  function renderEbayLiveEvents(events) {
    const grid = document.getElementById("ebay-live-grid");
    if (!grid) return;

    const list = filterAndSortUpcomingEvents(events).slice(0, 3);
    if (!list.length) {
      grid.innerHTML = `
        <div class="live-preview-empty">
          No upcoming eBay Live events are scheduled right now. Check back soon for the next OG show.
        </div>
      `;
      return;
    }

    grid.innerHTML = list
      .map((event) => {
        const theme = getThemeFromTitle(event.title);
        const title = ebayEsc(event.title || "Upcoming eBay Live");
        const url = ebayEsc(
          event.url || "https://www.ebay.com/ebaylive/sellers/lertro4xscs"
        );
        const status = ebayEsc(getEventStatusLabel(event));
        const dateText = ebayEsc(formatDisplayDate(event));
        const timeText = ebayEsc(formatTimeZone(event));
        const countdown = ebayEsc(getCountdownLabel(event));
        const summary = ebayEsc(getEventSummary(event, theme));
        const themeLabel = ebayEsc(getThemeLabel(theme));
        const liveMeta = event.__isLiveNow ? "Now streaming" : "Scheduled event";

        return `
        <article class="live-preview-card" data-theme="${theme}">
          <div class="live-preview-media">
            <div class="live-preview-surface">
              <div class="live-preview-topline">
                <span class="live-badge">${status}</span>
                <span class="live-countdown">${countdown}</span>
              </div>
              <div class="live-preview-theme-block">
                <p class="live-preview-theme-label">${themeLabel}</p>
                <span class="live-date-pill">${dateText}</span>
              </div>
            </div>
          </div>
          <div class="live-preview-transition" aria-hidden="true"></div>

          <div class="live-preview-body">
            <h3 class="live-preview-title">${title}</h3>
            <p class="live-preview-copy">${summary}</p>

            <div class="live-preview-meta">
              <span>${timeText}</span>
              <span>${ebayEsc(event.seller || "OG Jewelers")}</span>
              <span>${liveMeta}</span>
            </div>

            <div class="live-preview-footer">
              <span class="live-preview-state">Live event data from eBay</span>
              <a
                class="live-preview-linkout"
                href="${url}"
                target="_blank"
                rel="noopener noreferrer"
              >
                View on eBay Live
              </a>
            </div>
          </div>
        </article>
      `;
      })
      .join("");
  }

  async function loadEbayLiveEvents() {
    const grid = document.getElementById("ebay-live-grid");
    if (!grid) return;

    try {
      grid.innerHTML = `<div class="live-preview-empty">Loading upcoming eBay Live events...</div>`;

      const res = await fetch(EBAY_LIVE_FN_URL, {
        method: "GET",
        cache: "no-store",
      });

      if (!res.ok) {
        throw new Error(`ebay_live_fetch_failed (${res.status})`);
      }

      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      renderEbayLiveEvents(items);
    } catch (error) {
      console.error("Failed to load eBay Live events:", error);
      renderEbayLiveEvents(EBAY_LIVE_FALLBACK_EVENTS);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    markReady();
    setupSectionReveal();
    setupHeroParallax();
    setupTestimonials();
    loadEbayLiveEvents();
  });
})();
