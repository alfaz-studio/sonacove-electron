/* Screenshare controls bar — "Thread" renderer.
   Hover reveals the inline controls (CSS only, no window resize). The window
   grows taller solely to fit the More menu. Timer ticks from the conference
   start timestamp pushed by the main process. */
(function() {
    const api = window.controlsBarAPI || {};
    const root = document.getElementById('cbRoot');
    const thread = document.getElementById('cbThread');
    const stopBtn = document.getElementById('cbStopShare');
    const controls = document.getElementById('cbControls');
    const controlsInner = document.getElementById('cbControlsInner');
    const more = document.getElementById('cbMore');
    const moreBtn = document.getElementById('cbMoreBtn');
    const hint = document.getElementById('cbHint');
    const audioBtn = document.getElementById('cbAudio');
    const videoBtn = document.getElementById('cbVideo');
    const participantsBtn = document.getElementById('cbParticipants');
    const chatBtn = document.getElementById('cbChat');
    const partBadge = document.getElementById('cbPartBadge');
    const chatBadge = document.getElementById('cbChatBadge');
    const timerVal = document.querySelector('.cb-timer-val');

    // ── Meeting timer ───────────────────────────────────────────────────────
    // Main pushes the conference start timestamp (epoch ms); we tick locally,
    // mirroring jitsi's ConferenceTimer formatting (mm:ss, or H:mm:ss past 1h).

    let startTimestamp = null;
    let timerInterval = null;

    /** Two-digit zero pad. */
    function pad(n) {
        return n < 10 ? `0${n}` : String(n);
    }

    /** Format elapsed milliseconds as mm:ss, or H:mm:ss once past an hour. */
    function formatElapsed(ms) {
        const totalSec = Math.floor(Math.max(0, ms) / 1000);
        const hours = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;

        return hours > 0
            ? `${hours}:${pad(mins)}:${pad(secs)}`
            : `${pad(mins)}:${pad(secs)}`;
    }

    /** Refresh the timer label from the current clock. */
    function tickTimer() {
        if (startTimestamp && timerVal) {
            timerVal.textContent = formatElapsed(Date.now() - startTimestamp);
        }
    }

    /** (Re)start the 1s timer loop from a conference start timestamp. */
    function startTimer(ts) {
        startTimestamp = typeof ts === 'number' ? ts : null;
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        if (!startTimestamp) {
            return;
        }
        tickTimer();
        timerInterval = setInterval(tickTimer, 1000);
    }

    api.onConferenceTimestamp?.(startTimer);

    // ── Mic / camera ─────────────────────────────────────────────────────────
    // Both on/off SVGs live in the markup; CSS swaps them on .cb-btn--danger.
    // Clicking forwards a toggle to the meeting renderer.

    /** Reflect the live mic/cam muted state on the Audio/Video buttons. */
    function applyAvState(state) {
        audioBtn?.classList.toggle('cb-btn--danger', Boolean(state && state.audioMuted));
        videoBtn?.classList.toggle('cb-btn--danger', Boolean(state && state.videoMuted));
    }

    api.onAvState?.(applyAvState);
    audioBtn?.addEventListener('click', () => api.toggleAudio?.());
    videoBtn?.addEventListener('click', () => api.toggleVideo?.());

    // ── Participants / Chat ──────────────────────────────────────────────────
    // Badges show the live participant count (when not alone) and chat unread
    // count (when > 0); clicking opens the matching pane in the meeting.

    /** Reflect the live participant / unread counts on the badges. */
    function applyCounts(state) {
        const people = Number(state && state.participantCount) || 0;
        const unread = Number(state && state.unreadCount) || 0;

        if (partBadge) {
            partBadge.textContent = String(people);
            partBadge.hidden = people <= 1;
        }
        if (chatBadge) {
            chatBadge.textContent = unread > 99 ? '99+' : String(unread);
            chatBadge.hidden = unread <= 0;
        }
    }

    api.onCounts?.(applyCounts);
    participantsBtn?.addEventListener('click', () => api.openParticipants?.());
    chatBtn?.addEventListener('click', () => api.openChat?.());

    // ── More menu ─────────────────────────────────────────────────────────
    // Opening the menu grows the window taller (top-fixed) so it isn't clipped;
    // closing shrinks it back.

    /** Closes the More dropdown and shrinks the window back. */
    function closeMore() {
        if (more?.classList.contains('is-open')) {
            more.classList.remove('is-open');
            api.setHover?.(false);
        }
    }

    /** Opens the More dropdown and grows the window to fit it. */
    function openMore() {
        more?.classList.add('is-open');
        api.setHover?.(true);
    }

    // ── First-run intro ───────────────────────────────────────────────────
    // Briefly open on load so the user sees the bar is expandable, then collapse
    // and surface a one-time hint. Any hover ends the intro + dismisses the hint.
    let introActive = true;
    let introTimer = null;

    /** Ends the intro: cancels the auto-collapse and hides the hint for good. */
    function endIntro() {
        if (!introActive) {
            return;
        }
        introActive = false;
        if (introTimer) {
            clearTimeout(introTimer);
        }
        hint?.classList.remove('is-on');
    }

    // Appear already fully expanded (no grow-in) — disable transitions for the
    // first paint, then re-enable them so only the collapse animates.
    root.classList.add('no-anim');
    thread.classList.add('is-expanded');
    controlsInner?.classList.add('is-settled');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('no-anim')));

    introTimer = setTimeout(() => {
        if (!introActive) {
            return;
        }
        thread.classList.remove('is-expanded');
        controlsInner?.classList.remove('is-settled');

        // Reveal the hint once the collapse has settled.
        setTimeout(() => {
            if (introActive) {
                hint?.classList.add('is-on');
            }
        }, 480);
    }, 2600);

    // ── Hover reveal ──────────────────────────────────────────────────────
    // Expand/collapse are driven by the click-through hit-test below (mousemove),
    // not mouseenter/leave — once the window goes click-through it stops getting
    // those events, which would leave the bar stuck open.

    /** Expand the capsule (reveal controls) and end any first-run intro. */
    function expandBar() {
        thread.classList.add('is-expanded');
        endIntro();
    }

    /** Collapse the capsule and tidy up (clip controls, hide tip/menu). */
    function collapseBar() {
        thread.classList.remove('is-expanded');
        controlsInner?.classList.remove('is-settled');
        hideTip();
        closeMore();
    }

    // Once the grow finishes, stop clipping so the chat badge + More menu (which
    // overflow the row) can show. Guarded on is-expanded so the collapse
    // transition doesn't re-enable overflow mid-shrink.
    controls?.addEventListener('transitionend', e => {
        if (e.propertyName === 'grid-template-columns' && thread.classList.contains('is-expanded')) {
            controlsInner?.classList.add('is-settled');
        }
    });

    // ── More toggle + outside-click close ─────────────────────────────────
    moreBtn?.addEventListener('click', e => {
        e.stopPropagation();
        hideTip();
        if (more.classList.contains('is-open')) {
            closeMore();
        } else {
            openMore();
        }
    });
    more?.querySelector('.cb-menu-item')?.addEventListener('click', closeMore);
    document.addEventListener('click', e => {
        if (more && !more.contains(e.target)) {
            closeMore();
        }
    });

    // ── Custom tooltip ────────────────────────────────────────────────────
    // Replaces the OS-native title tooltip. One shared element, repositioned
    // under whichever [data-tip] control is hovered.
    const tip = document.createElement('div');

    tip.className = 'cb-tip';
    root.appendChild(tip);

    /** Show the tooltip centred just below a control button. */
    function showTip(btn) {
        const text = btn.getAttribute('data-tip');

        if (!text) {
            return;
        }
        tip.textContent = text;
        const r = btn.getBoundingClientRect();
        const rootR = root.getBoundingClientRect();

        tip.style.left = `${r.left - rootR.left + (r.width / 2)}px`;
        tip.style.top = `${r.bottom - rootR.top + 8}px`;
        tip.classList.add('is-on');
    }

    /** Hide the tooltip. */
    function hideTip() {
        tip.classList.remove('is-on');
    }

    document.querySelectorAll('[data-tip]').forEach(btn => {
        btn.addEventListener('mouseenter', () => showTip(btn));
        btn.addEventListener('mouseleave', hideTip);
    });

    // ── Stop share ────────────────────────────────────────────────────────
    stopBtn?.addEventListener('click', e => {
        e.stopPropagation();
        api.stopShare?.();
    });

    // ── Drag the window by the capsule (but not its buttons) ──────────────
    thread.addEventListener('mousedown', e => {
        if (e.target.closest('button')) {
            return;
        }
        thread.classList.add('is-dragging');
        api.startDrag?.();
    });
    window.addEventListener('mouseup', () => {
        thread.classList.remove('is-dragging');
        api.stopDrag?.();
    });

    // ── Click-through + hover ───────────────────────────────────────────────
    // The window starts ignoring mouse events so the transparent margins fall
    // through to the screen/meeting behind. Over the capsule (its expanded
    // controls + open menu are inside #cbThread) we capture the mouse AND expand;
    // off it we release (click-through) AND collapse. `forward: true` keeps
    // mousemove flowing while ignored so we can detect the cursor returning.
    let mouseIgnored = true;

    document.addEventListener('mousemove', e => {
        const overCapsule = Boolean(document.elementFromPoint(e.clientX, e.clientY)?.closest('#cbThread'));

        if (overCapsule === mouseIgnored) {
            mouseIgnored = !overCapsule;
            api.setIgnoreMouse?.(mouseIgnored);
            if (overCapsule) {
                expandBar();
            } else {
                collapseBar();
            }
        }
    });
})();
