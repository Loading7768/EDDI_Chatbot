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
        .getPropertyValue('--ease-spring')
        .trim();
    console.log(value)

    return value || 'ease-out'; // fallback if the variable is ever missing
}

function flipAnimate(elements, mutate, options = {}) {
    const duration = options.duration ?? 500;
    const easing = options.easing ?? 'cubic-bezier(0.34,1.56,0.64,1)';

    // FIRST: record starting rects before anything changes
    const firstRects = new Map();
    elements.forEach((el) => firstRects.set(el, el.getBoundingClientRect()));

    // Apply the actual state mutation (e.g. this.currentStep++)
    mutate();

    // Wait for Alpine to finish patching the DOM from that mutation before
    // measuring the "last" rects — measuring too early would just capture
    // stale (pre-update) layout.
    Alpine.nextTick(() => {
        elements.forEach((el) => {
            if (!document.body.contains(el)) return; // element was removed entirely
            const first = firstRects.get(el);
            if (!first) return;

            const last = el.getBoundingClientRect();

            const dx = first.left - last.left;
            const dy = first.top - last.top;
            const sameSize =
                Math.abs(first.width - last.width) < 0.5 &&
                Math.abs(first.height - last.height) < 0.5;
            const samePosition = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5;

            if (samePosition && sameSize) return; // nothing to animate

            // INVERT: pin the element to its old position and old size,
            // with transitions disabled so this jump is instant
            el.style.transition = 'none';
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            el.style.width = `${first.width}px`;
            el.style.height = `${first.height}px`;

            void el.offsetHeight; // force reflow so the browser registers the above

            // PLAY: animate back to the real (new) position/size
            requestAnimationFrame(() => {
                el.style.transition = [
                    `transform ${duration}ms ${easing}`,
                    `width ${duration}ms ${easing}`,
                    `height ${duration}ms ${easing}`,
                ].join(', ');
                el.style.transform = 'none';
                el.style.width = '';
                el.style.height = '';

                const cleanup = () => {
                    el.style.transition = '';
                    el.removeEventListener('transitionend', cleanup);
                };
                el.addEventListener('transitionend', cleanup);
            });
        });
    });
}

window.flipAnimate = flipAnimate;

console.log('flip.js loaded.')