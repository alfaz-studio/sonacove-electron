/* Screenshare controls bar — renderer logic (Phase 1).
   Handles hover expand/collapse and window dragging via the preload bridge.
   Control actions (mute, stop share, etc.) are wired in Phase 2. */
(function() {
    const api = window.controlsBarAPI || {};
    const root = document.getElementById('cbRoot');
    const strip = document.getElementById('cbStrip');
    const stopBtn = document.getElementById('cbStopShare');
    const more = document.querySelector('.cb-more');

    let expanded = false;

    /** Close the More dropdown. */
    function closeMore() {
        more?.classList.remove('is-open');
    }

    /**
     * Reveal the controls: grow the window FIRST (so there's room), then on the
     * next frame slide the bar down into it.
     */
    function expand() {
        if (expanded) {
            return;
        }
        expanded = true;
        api.setHover?.(true);
        requestAnimationFrame(() => {
            if (expanded) {
                root.classList.add('is-expanded');
            }
        });
    }

    /**
     * Hide the controls: slide the bar back up now; the window shrinks only once
     * the slide finishes (see the transitionend handler), so nothing clips mid-
     * animation.
     */
    function collapse() {
        if (!expanded) {
            return;
        }
        expanded = false;
        closeMore();
        root.classList.remove('is-expanded');
    }

    // Shrink the window once the collapse slide has finished.
    root.addEventListener('transitionend', e => {
        if (e.target === root && e.propertyName === 'transform' && !expanded) {
            api.setHover?.(false);
        }
    });

    // Hovering the strip reveals the controls; leaving the whole bar hides them.
    strip.addEventListener('mouseenter', expand);
    root.addEventListener('mouseleave', collapse);

    // Drag the window by the strip (but not when starting on the Stop-share btn).
    strip.addEventListener('mousedown', e => {
        if (e.target.closest('#cbStopShare')) {
            return;
        }
        api.startDrag?.();
    });
    window.addEventListener('mouseup', () => api.stopDrag?.());

    stopBtn?.addEventListener('click', e => {
        e.stopPropagation();
        api.stopShare?.();
    });

    // More dropdown: toggle on click, close on outside click / item select.
    if (more) {
        const moreBtn = more.querySelector('.cb-item');

        moreBtn?.addEventListener('click', e => {
            e.stopPropagation();
            more.classList.toggle('is-open');
        });

        more.querySelector('.cb-menu-item')?.addEventListener('click', closeMore);

        document.addEventListener('click', e => {
            if (!more.contains(e.target)) {
                closeMore();
            }
        });
    }
})();
