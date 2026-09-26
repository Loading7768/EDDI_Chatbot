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
//
// 使用場景：webpage/form/js/app.js 的 runWithNodeFlip() 會在每次切換步驟
// （nextStep / jumpTo）時，蒐集所有帶有 data-flip 屬性的 DOM 節點
// （即 form.html 中每個步驟卡片的外框，以及卡片之間的連接線），
// 呼叫本檔案的 flipAnimate()，讓這些節點從「切換前的大小/位置」平滑動畫到
// 「切換後（因 Alpine x-if / :class 改變而重新排版）的大小/位置」，
// 取代原本 Alpine 沒有動畫、DOM 一改就直接跳格的預設行為。

// Reads the same --ease-brand variable style.css defines, so the JS-driven
// FLIP animation and the CSS transitions elsewhere use one identical curve.
// 註：目前 flipAnimate() 實際使用的是自帶的 cubic-bezier 預設值，
// getBrandEasing() 這個輔助函式目前在本檔案中沒有被呼叫使用（保留供未來
// 需要與 CSS 端 --ease-spring 變數對齊時使用），呼叫它單純是為了在
// console.log 印出目前讀到的變數值以便除錯。
function getBrandEasing() {
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue('--ease-spring')
        .trim();
    console.log(value)

    return value || 'ease-out'; // fallback if the variable is ever missing
}

// flipAnimate(elements, mutate, options)
// 參數：
//   elements — 要套用動畫的 DOM 節點陣列（呼叫端先用 querySelectorAll 蒐集好）
//   mutate   — 一個會改變狀態、進而讓 Alpine 重新渲染上述節點的函式
//              （例如 () => { this.currentStep++ }）
//   options  — { duration, easing } 可選的動畫時長（預設 500ms）與緩動曲線
//              （預設 cubic-bezier(0.34,1.56,0.64,1)，帶有輕微回彈感）
// 流程即 FLIP 四個字母的縮寫：
//   First  — 在狀態改變「之前」先記錄每個節點目前的位置與大小
//   Last   — 執行 mutate() 讓 Alpine 依新狀態重新渲染 DOM，再記錄「之後」的位置與大小
//   Invert — 用 transform + 固定 width/height，把節點瞬間「假裝」還停留在舊的位置與大小
//   Play   — 移除上述假裝設定、開啟 CSS transition，讓瀏覽器把它動畫回真正的新位置與大小
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

                // transitionend 觸發後把 inline transition 樣式清掉，
                // 避免殘留的 transition 屬性影響下一次非 FLIP 觸發的樣式變化
                // （例如純 CSS 的 hover 效果）。
                const cleanup = () => {
                    el.style.transition = '';
                    el.removeEventListener('transitionend', cleanup);
                };
                el.addEventListener('transitionend', cleanup);
            });
        });
    });
}

// 掛到 window 上，讓沒有走 ES module 匯入機制的 app.js 可以直接呼叫
// window.flipAnimate(...)（三份 JS 皆以傳統 <script> 標籤依序載入，
// 彼此透過全域變數共享，而非 import/export）。
window.flipAnimate = flipAnimate;

console.log('flip.js loaded.')
