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
    const annotateBtn = document.getElementById('cbAnnotate');
    const partBadge = document.getElementById('cbPartBadge');
    const chatBadge = document.getElementById('cbChatBadge');
    const liveText = document.getElementById('cbLiveText');
    const liveEl = document.querySelector('.cb-live');
    const stopText = document.getElementById('cbStopText');
    const timerVal = document.querySelector('.cb-timer-val');
    const recordItem = document.getElementById('cbRecord');

    // ── Pending (loading) state ───────────────────────────────────────────────
    // Mic/cam/annotate/record toggles round-trip to the meeting renderer; show a
    // spinner on the clicked control until the resulting state echoes back. A
    // timeout clears it so a dropped update can't leave a control stuck spinning.
    // Per-control loading state with timing: the spinner stays visible for a
    // minimum (so fast ops like a warm camera still register) and never spins
    // forever (a dropped completion signal clears at the max).
    const loadingState = new Map();
    const MIN_SPINNER_MS = 400;
    const MAX_SPINNER_MS = 4000;

    function clearLoading(el) {
        const s = loadingState.get(el);

        if (s?.timer) {
            clearTimeout(s.timer);
        }
        loadingState.delete(el);
        el.classList.remove('cb-loading');
    }

    function setLoading(el, on) {
        if (!el) {
            return;
        }
        if (on) {
            const existing = loadingState.get(el);

            if (existing?.timer) {
                clearTimeout(existing.timer);
            }
            el.classList.add('cb-loading');
            loadingState.set(el, {
                shownAt: Date.now(),
                timer: setTimeout(() => clearLoading(el), MAX_SPINNER_MS)
            });

            return;
        }

        const s = loadingState.get(el);

        if (!s) {
            return;
        }

        const remaining = MIN_SPINNER_MS - (Date.now() - s.shownAt);

        if (remaining <= 0) {
            clearLoading(el);
        } else {
            // Hold the spinner for the minimum visible time, then clear.
            clearTimeout(s.timer);
            s.timer = setTimeout(() => clearLoading(el), remaining);
        }
    }

    // ── Localized strings ─────────────────────────────────────────────────────
    // This window has no i18n runtime of its own; main pushes the translated
    // strings (cb-strings) on load. The HTML ships English as the initial paint;
    // we overwrite it here and keep the map for the stateful Record / Annotate
    // labels. cb-strings is sent before the state replays, so those land
    // localized too (see applyRecording / applyAnnotate below).
    let strings = {};

    // Annotate is gated on an active screenshare: you annotate over the shared
    // screen, so with nothing shared there's nothing to draw on. Track both bits
    // so the button can read as disabled and explain why on click.
    let isSharing = false;
    let annotating = false;

    /** Set a button's tooltip text (read by showTip on hover). */
    function setTip(btn, text) {
        if (btn && text) {
            btn.setAttribute('data-tip', text);
        }
    }

    /** Apply the localized UI strings pushed from main. */
    function applyStrings(s) {
        if (!s) {
            return;
        }
        strings = s;
        if (s.windowTitle) {
            document.title = s.windowTitle;
        }
        if (liveText && s.live) {
            liveText.textContent = s.live;
        }
        if (stopText && s.stop) {
            stopText.textContent = s.stop;
        }
        if (hint && s.hint) {
            hint.textContent = s.hint;
        }
        setTip(audioBtn, s.audio);
        setTip(videoBtn, s.video);
        setTip(participantsBtn, s.participants);
        setTip(chatBtn, s.chat);
        setTip(moreBtn, s.more);
    }

    api.onStrings?.(applyStrings);

    /**
     * Apply host theme tokens so the bar's accent/active states follow the app
     * theme instead of the hardcoded orange defaults. --action-soft derives from
     * --action via color-mix (see controls-bar.css), so it follows automatically.
     */
    function applyTheme(theme) {
        if (!theme) {
            return;
        }
        const rootStyle = document.documentElement.style;

        if (theme.accent) {
            rootStyle.setProperty('--action', theme.accent);
        }
        if (theme.accentHover) {
            rootStyle.setProperty('--action-hover', theme.accentHover);
            rootStyle.setProperty('--action-glyph', theme.accentHover);
        }
        if (theme.danger) {
            rootStyle.setProperty('--danger', theme.danger);
        }
        if (theme.dangerIcon) {
            rootStyle.setProperty('--danger-hover', theme.dangerIcon);
        }
    }

    api.onTheme?.(applyTheme);

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
        setLoading(audioBtn, false);

        // Keep the camera spinner up while it's still warming up (videoPending),
        // even when this update was triggered by an unrelated audio change.
        if (!(state && state.videoPending)) {
            setLoading(videoBtn, false);
        }
    }

    api.onAvState?.(applyAvState);
    audioBtn?.addEventListener('click', () => {
        setLoading(audioBtn, true);
        api.toggleAudio?.();
    });
    videoBtn?.addEventListener('click', () => {
        setLoading(videoBtn, true);
        api.toggleVideo?.();
    });

    // ── Participants / Chat ──────────────────────────────────────────────────
    // Badges show the live participant count (when not alone) and chat unread
    // count (when > 0); clicking opens the matching pane in the meeting.

    /** Reflect the live participant / unread counts on the badges. */
    function applyCounts(state) {
        const people = Number(state && state.participantCount) || 0;
        const unread = Number(state && state.unreadCount) || 0;

        if (partBadge) {
            partBadge.textContent = String(people);
            partBadge.hidden = people < 1;
        }
        if (chatBadge) {
            chatBadge.textContent = unread > 99 ? '99+' : String(unread);
            chatBadge.hidden = unread <= 0;
        }
    }

    api.onCounts?.(applyCounts);
    participantsBtn?.addEventListener('click', () => api.openParticipants?.());
    chatBtn?.addEventListener('click', () => api.openChat?.());

    // ── Annotate ─────────────────────────────────────────────────────────────
    // Highlights when annotation is on (which the desktop picker's "Open
    // annotation tools" toggle drives on share start); clicking toggles it.

    /** Set the Annotate tooltip from the current annotating state. The
        "share first" reason is surfaced only via the click toast, never the
        tooltip — otherwise both show the same text at once. */
    function refreshAnnotateTip() {
        const tip = annotating ? strings.stopAnnotating : strings.annotate;

        if (tip) {
            annotateBtn?.setAttribute('data-tip', tip);
        }

        // Refresh live if hovered, since the state can flip with the cursor on it.
        if (annotateBtn?.matches(':hover')) {
            showTip(annotateBtn);
        }
    }

    /** Reflect the live annotation on/off state on the Annotate button. */
    function applyAnnotate(state) {
        annotating = Boolean(state && state.annotating);

        annotateBtn?.classList.toggle('cb-btn--active', annotating);

        // Close settles immediately here; the OPEN spinner instead waits for the
        // overlay to actually be up (onAnnotateReady below).
        if (!annotating) {
            setLoading(annotateBtn, false);
        }

        refreshAnnotateTip();
    }

    api.onAnnotate?.(applyAnnotate);

    // Overlay window is actually up (a few seconds after the click) — clear the
    // open spinner now that annotation is really live.
    api.onAnnotateReady?.(() => setLoading(annotateBtn, false));

    // Default to the disabled look until the first sharing-state replay arrives
    // (which corrects it via applySharing).
    annotateBtn?.classList.add('cb-btn--disabled');

    annotateBtn?.addEventListener('click', () => {
        // Annotations need an active screenshare. While not sharing the button
        // reads as disabled — surface the reason via the same toast used for the
        // recording notifications, instead of toggling.
        if (!isSharing) {
            applyToast({ message: strings.annotateNeedsShare });

            return;
        }
        setLoading(annotateBtn, true);
        api.toggleAnnotate?.();
    });

    // ── Share / Stop ─────────────────────────────────────────────────────────
    // While sharing: red "Stop" (monitor-x) + the "SHARING" status. While not
    // sharing: green "Share" (monitor-up), status hidden. The trailing button is
    // one element that morphs; the click starts or stops sharing accordingly.

    /** Reflect the live screenshare on/off state on the trailing button + status. */
    function applySharing(state) {
        const on = Boolean(state && state.sharing);

        isSharing = on;

        // Annotate is only usable while sharing; reflect that as a disabled look.
        // The click still fires (no pointer-events:none) so it can show the
        // "share first" toast.
        annotateBtn?.classList.toggle('cb-btn--disabled', !on);
        refreshAnnotateTip();

        // Share mode = NOT sharing.
        stopBtn?.classList.toggle('is-share', !on);
        if (liveEl) {
            liveEl.hidden = !on;
        }
        if (stopText) {
            const label = on ? strings.stop : strings.share;

            if (label) {
                stopText.textContent = label;
            }
        }
    }

    api.onSharing?.(applySharing);

    // ── Recording label ──────────────────────────────────────────────────────
    const recordLabel = document.getElementById('cbRecordLabel');

    /** Reflect local recording state on the Record menu label. */
    function applyRecording(state) {
        const wasPending = recordItem?.classList.contains('cb-loading');

        setLoading(recordItem, false);

        const label = state && state.recording ? strings.stopRecording : strings.record;

        if (recordLabel && label) {
            recordLabel.textContent = label;
        }

        // The More menu was held open to show the record spinner — close it now
        // that the recording state has resolved.
        if (wasPending) {
            closeMore();
        }
    }

    api.onRecording?.(applyRecording);

    // ── Toast ────────────────────────────────────────────────────────────────
    // Mirrors jitsi's recording notifications: a message, an optional sub-line
    // (e.g. "Saved to …"), and an optional action button ("Show in folder").
    const toast = document.getElementById('cbToast');
    const toastMsg = document.getElementById('cbToastMsg');
    const toastSub = document.getElementById('cbToastSub');
    const toastAction = document.getElementById('cbToastAction');
    let toastTimer = null;

    /** Show a transient toast ({ message, sub?, actionLabel? }) below the bar. */
    function applyToast(data) {
        if (!toast || !toastMsg || !toastSub || !toastAction || !data || !data.message) {
            return;
        }
        toastMsg.textContent = data.message;
        toastSub.textContent = data.sub || '';
        toastSub.hidden = !data.sub;
        toastAction.hidden = !data.actionLabel;
        if (data.actionLabel) {
            toastAction.textContent = data.actionLabel;
        }
        toast.classList.add('is-on');

        // The toast owns the band below the capsule — clear the tooltip and the
        // drag hint so the three popups never stack in the same spot.
        hideTip();
        hideDragHint();

        if (toastTimer) {
            clearTimeout(toastTimer);
        }

        // Toasts with an action stay up longer so the button can be clicked.
        toastTimer = setTimeout(() => toast.classList.remove('is-on'), data.actionLabel ? 6500 : 3000);
    }

    api.onToast?.(applyToast);
    toastAction?.addEventListener('click', () => {
        api.openRecording?.();
        toast.classList.remove('is-on');
    });

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

        // The menu opens below the capsule, where the (below-placed) drag hint
        // sits — hide the hint so the two never overlap.
        hideDragHint();
    }

    // ── "Drag to move" hint ─────────────────────────────────────────────────
    // Shown only the FIRST time the user hovers the bar, for a few seconds, and
    // never while the More menu is open. (The PiP pill keeps an always-on hover
    // hint; the bar and PiP panel are timed.)
    const dragHint = thread?.querySelector('.draghint');
    let dragHintDone = false;
    let dragHintTimer = null;
    const DRAG_HINT_MS = 3500;

    /** Hides the drag hint and clears its auto-dismiss timer. */
    function hideDragHint() {
        if (dragHintTimer) {
            clearTimeout(dragHintTimer);
            dragHintTimer = null;
        }
        dragHint?.classList.remove('is-shown');
    }

    thread?.addEventListener('mouseenter', () => {
        if (dragHintDone || more?.classList.contains('is-open') || toast?.classList.contains('is-on')) {
            return;
        }
        dragHintDone = true;
        dragHint?.classList.add('is-shown');
        dragHintTimer = setTimeout(hideDragHint, DRAG_HINT_MS);
    });

    // ── First-run intro ───────────────────────────────────────────────────
    // Played only the FIRST time the bar ever appears — the main process gates
    // it via cb-intro ({ play }) and persists the "shown" flag to disk, so it
    // doesn't replay every time the bar reopens on minimize. Briefly expands so
    // the user sees the bar is expandable, then collapses and surfaces a one-time
    // hint. Any hover ends the intro + dismisses the hint.
    let introActive = false;
    let introTimer = null;
    let innerIntroTimer = null;

    /** Ends the intro: cancels the auto-collapse and hides the hint for good. */
    function endIntro() {
        if (!introActive) {
            return;
        }
        introActive = false;
        if (introTimer) {
            clearTimeout(introTimer);
        }
        if (innerIntroTimer) {
            clearTimeout(innerIntroTimer);
        }
        hint?.classList.remove('is-on');
    }

    /** Runs the one-time intro: grow in, hold, then collapse + reveal the hint. */
    function playIntro() {
        introActive = true;
        thread.classList.add('is-expanded'); // animates the grow-in (is-settled lands via transitionend)

        introTimer = setTimeout(() => {
            if (!introActive) {
                return;
            }
            thread.classList.remove('is-expanded');
            controlsInner?.classList.remove('is-settled');

            // Reveal the hint once the collapse has settled.
            innerIntroTimer = setTimeout(() => {
                innerIntroTimer = null;
                if (introActive) {
                    hint?.classList.add('is-on');
                }
            }, 480);
        }, 2600);
    }

    api.onIntro?.(data => {
        if (data && data.play) {
            playIntro();
        }
    });

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
    recordItem?.addEventListener('click', () => {
        setLoading(recordItem, true);
        api.toggleRecord?.();
        // Keep the menu open so the spinner stays visible; applyRecording closes
        // it once the recording state confirms (or the loading timeout fires).
    });
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
        // Toast outranks the tooltip — they share the band below the capsule, so
        // suppress the tooltip whenever a toast (recording / annotate) is up.
        if (toast?.classList.contains('is-on')) {
            return;
        }

        const text = btn.getAttribute('data-tip');

        if (!text) {
            return;
        }

        // Tooltip and the drag hint share the band below the capsule — showing a
        // tooltip clears the (lower-priority, transient) drag hint so they can't
        // overlap.
        hideDragHint();

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

    // ── Stop / Start share ──────────────────────────────────────────────────
    stopBtn?.addEventListener('click', e => {
        e.stopPropagation();
        if (stopBtn.classList.contains('is-share')) {
            api.startShare?.();
        } else {
            api.stopShare?.();
        }
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

    // Safety net: if the cursor leaves the window without a final margin mousemove
    // (so collapseBar never fires), losing focus still collapses + closes the menu
    // so the window can't stay stuck expanded/tall.
    window.addEventListener('blur', collapseBar);

    // ── Click-through + hover ───────────────────────────────────────────────
    // The window starts ignoring mouse events so the transparent margins fall
    // through to the screen/meeting behind. Over the capsule (its expanded
    // controls + open menu are inside #cbThread) we capture the mouse AND expand;
    // off it we release (click-through) AND collapse. `forward: true` keeps
    // mousemove flowing while ignored so we can detect the cursor returning.
    let mouseIgnored = true;
    let hoverExpanded = false;

    document.addEventListener('mousemove', e => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const overCapsule = Boolean(el?.closest('#cbThread'));

        // The toast's action button is outside the capsule but must stay clickable.
        const interactive = overCapsule || Boolean(el?.closest('#cbToastAction'));

        if (interactive === mouseIgnored) {
            mouseIgnored = !interactive;
            api.setIgnoreMouse?.(mouseIgnored);
        }

        // Expand/collapse follows the capsule only (hovering the toast must not expand).
        if (overCapsule !== hoverExpanded) {
            hoverExpanded = overCapsule;
            if (overCapsule) {
                expandBar();
            } else {
                collapseBar();
            }
        }
    });
})();
