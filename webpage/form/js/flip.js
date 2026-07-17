// flip.js — generic FLIP (First, Last, Invert, Play) helper.
// No dependency on the form's state or Alpine directives beyond
// Alpine.nextTick(), which just waits for Alpine's own DOM patch to
// finish before we measure. Reusable for any element set.
//
// Deliberately avoids transform: scale() for the size change (a classic
// FLIP shortcut) because scaling also stretches whatever text/content is
// inside, which looks distorted mid-transition. Instead this animates
// real width/height for size, and transform: translate() only for
// position — translate never distorts content, so this stays clean even
// though it's marginally more expensive than a pure transform animation.
// For the handful of elements and infrequent triggers here, that cost is
// irrelevant.

// Reads the same --ease-brand variable style.css defines, so the JS-driven
// FLIP animation and the CSS transitions elsewhere use one identical curve.
function getBrandEasing() {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--ease-brand')
    .trim();
  return value || 'ease-out'; // fallback if the variable is ever missing
}

// Tracks any element currently mid-animation from a PRIOR flipAnimate()
// call, so a rapid second action (click again before the first transition
// settles) doesn't measure a mid-transition size as its "first" rect. If a
// new cycle starts while an element is still animating, its old animation
// is snapped to its resting state immediately (cut short, not dropped —
// the state change it represented already happened) before the new
// cycle's measurement begins.
const activeCleanups = new WeakMap();

function cancelIfAnimating(el) {
  const cleanup = activeCleanups.get(el);
  if (cleanup) {
    cleanup();
    activeCleanups.delete(el);
  }
}

function flipAnimate(elements, mutate, options = {}) {
  const duration = options.duration ?? 500;
  const easing = 'cubic-bezier(0.25,1,0.5,1)';


  // Settle any element still mid-animation from a previous cycle BEFORE
  // measuring "first" rects — otherwise a rapid second action could
  // capture an in-between (still-transitioning) size/position as if it
  // were the real starting point, producing a wrong/jumpy animation.
  elements.forEach((el) => cancelIfAnimating(el));

  // FIRST: record starting rects before anything changes. Elements hidden
  // via x-show (display:none) get a rect of all zeros from the browser —
  // recording that as "first" would make FLIP think the element's old
  // position was the top-left corner of the page, and animate a fly-in
  // from there. Record null instead so those get skipped entirely below.
  const firstRects = new Map();
  elements.forEach((el) => {
    const wasHidden = getComputedStyle(el).display === 'none';
    firstRects.set(el, wasHidden ? null : el.getBoundingClientRect());
  });

  // Apply the actual state mutation (e.g. this.currentStep++). This always
  // runs, regardless of any prior animation state — a state change (like
  // a real login response coming back) must never be dropped just because
  // something was still animating.
  mutate();

  // Wait for Alpine to finish patching the DOM from that mutation before
  // measuring the "last" rects — measuring too early would just capture
  // stale (pre-update) layout. The extra rAF after that gives Alpine's own
  // transition setup (e.g. a newly-mounted child's opacity:0 starting
  // state) a chance to actually paint first — our own forced reflow below
  // was previously happening in the same tick as Alpine's setup, which
  // could collapse its opacity:0 -> opacity:100 into a single frame with
  // no paint in between, making the child's fade-in invisible.
  Alpine.nextTick(() => {
    requestAnimationFrame(() => {
      // PASS 1: measure every element's "last" rect BEFORE touching any
      // inline styles. Doing measure-then-invert per element in a single
      // loop (the previous approach) meant an earlier element's invert
      // step — which forces it back to a smaller/different size — was a
      // real layout change that could shift where a LATER element (e.g. a
      // connector sitting right below a node) actually renders. That
      // later element would then measure a transient, corrupted position
      // instead of the true settled one, breaking the assumption that its
      // start/end rects genuinely line up with its neighbor's.
      const lastRects = new Map();
      elements.forEach((el) => {
        if (!document.body.contains(el)) return; // element was removed entirely
        const isHiddenNow = getComputedStyle(el).display === 'none';
        if (isHiddenNow) return; // hidden after the change — nothing to show
        lastRects.set(el, el.getBoundingClientRect());
      });

      // PASS 2: now that every real final rect is known, invert each
      // element (pin to its old position/size) without any risk of one
      // element's change corrupting another's already-captured data.
      const toPlay = [];
      elements.forEach((el) => {
        const first = firstRects.get(el);
        const last = lastRects.get(el);
        if (!first || !last) return; // was hidden before/after — skip

        const positionOnly = el.hasAttribute('data-flip-move');
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        const samePosition = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5;

        if (positionOnly) {
          if (samePosition) return; // nothing to animate
          el.style.transition = 'none';
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          toPlay.push({ el, positionOnly: true, last });
          return;
        }

        const sameSize =
          Math.abs(first.width - last.width) < 0.5 &&
          Math.abs(first.height - last.height) < 0.5;
        if (samePosition && sameSize) return; // nothing to animate

        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.style.width = `${first.width}px`;
        el.style.height = `${first.height}px`;
        toPlay.push({ el, positionOnly: false, last });
      });

      // One shared forced reflow covers every inverted element above —
      // reading a layout property forces the browser to flush ALL
      // pending style changes at once, not just the one we read from.
      void document.body.offsetHeight;

      // PASS 3: release into the real animation. Targets explicit pixel
      // values (from the already-measured "last" rect), not ''/auto — CSS
      // transitions can't smoothly interpolate toward auto, so clearing
      // straight to '' here would make the resize snap instantly even
      // though transform still animates. Release back to '' only after
      // the transition finishes, as pure cleanup.
      requestAnimationFrame(() => {
        toPlay.forEach(({ el, positionOnly, last }) => {
          if (positionOnly) {
            el.style.transition = `transform ${duration}ms ${easing}`;
            el.style.transform = 'none';

            const cleanup = () => {
              el.style.transition = '';
              el.style.transform = '';
              el.removeEventListener('transitionend', cleanupListener);
              activeCleanups.delete(el);
            };
            const cleanupListener = () => cleanup();
            el.addEventListener('transitionend', cleanupListener);
            activeCleanups.set(el, cleanup);
            return;
          }

          el.style.transition = [
            `transform ${duration}ms ${easing}`,
            `width ${duration}ms ${easing}`,
            `height ${duration}ms ${easing}`,
          ].join(', ');
          el.style.transform = 'none';
          el.style.width = `${last.width}px`;
          el.style.height = `${last.height}px`;

          // This same function is also what cancelIfAnimating() calls
          // early if a new cycle interrupts this one before it finishes
          // naturally — either way, it lands the element on its real
          // final values and releases the inline overrides.
          const cleanup = () => {
            el.style.transition = '';
            el.style.transform = '';
            el.style.width = '';
            el.style.height = '';
            el.removeEventListener('transitionend', cleanupListener);
            activeCleanups.delete(el);
          };
          const cleanupListener = () => cleanup();
          el.addEventListener('transitionend', cleanupListener);
          activeCleanups.set(el, cleanup);
        });
      });
    });
  });
}

window.flipAnimate = flipAnimate;

console.log('flip is loaded.')
