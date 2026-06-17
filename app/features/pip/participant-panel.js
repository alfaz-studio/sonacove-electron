/* Spotlight PiP renderer (ui_kits/desktop-overlay → ConceptSpotlight).
   One focused tile + a layout switch (single / split / grid) + an Auto/Pinned
   speaker-follow toggle. In `single`, a filmstrip of everyone (avatars unless
   the FILMSTRIP_VIDEO flag is on). Runs in a sandboxed window with a narrow
   `panelAPI` bridge (or a mock, for the standalone preview). */
(() => {
    const api = window.panelAPI || {};
    const cfg = window.panelConfig || {};
    const FILMSTRIP_VIDEO = Boolean(cfg.filmstripVideo);

    // ── Icons ────────────────────────────────────────────────────────────────
    const I = {
        single: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
        split: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/>',
        grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>'
            + '<line x1="3" y1="12" x2="21" y2="12"/>',
        radio: '<circle cx="12" cy="12" r="2"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14M19.07 4.93a10 10 0 0 1 0 14.14'
            + 'M7.76 16.24a6 6 0 0 1 0-8.49M16.24 7.76a6 6 0 0 1 0 8.49"/>',
        pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12'
            + 'a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8'
            + 'a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
        users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'
            + '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        micOn: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>'
            + '<line x1="12" x2="12" y1="19" y2="22"/>',
        micOff: '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/>'
            + '<path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/>'
            + '<path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>',
        minus: '<line x1="5" x2="19" y1="12" y2="12"/>',
        maximize2: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>'
            + '<line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
        hand: '<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/>'
            + '<path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 '
            + '0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'
    };

    /** Wrap icon path(s) in an svg with stroke styling. */
    const svg = (paths, size = 16) =>
        `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
        + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

    // ── State ──────────────────────────────────────────────────────────────────
    let roster = []; // full ranked roster (from data.roster)
    let total = 0;
    let layout = 'single'; // single | split | grid (user choice)
    let effLayout = 'single'; // effective layout this render (forced to single when alone)
    let auto = true; // follow active speaker
    let selId = null; // spotlighted participant id (when pinned)
    const frames = {}; // id → latest JPEG data URL
    let pillMode = false;
    let lastStructKey = ''; // rebuild the body only when this changes
    let lastStageKey = ''; // reportStage only when the on-stage set changes
    let lastSize = ''; // setSize only when the measured card changes
    let lastAuto = null; // re-render the Auto/Pinned glyph only when it flips
    let lastTotal = -1; // re-render the count only when it changes

    // ── DOM refs ────────────────────────────────────────────────────────────────
    const card = document.getElementById('card');
    const body = document.getElementById('body');
    const layoutSeg = document.getElementById('layoutSeg');
    const autoBtn = document.getElementById('autoBtn');
    const countEl = document.getElementById('count');
    const closeBtn = document.getElementById('closeBtn');
    const backBtn = document.getElementById('backBtn');
    const pillOverlay = document.getElementById('pillOverlay');
    const pillBtn = document.getElementById('pillBtn');
    const pillBadge = document.getElementById('pillBadge');

    if (window.panelPlatform === 'darwin') {
        pillBtn.classList.add('macos');
    }

    // Static header icons.
    closeBtn.innerHTML = svg(I.minus, 16);
    backBtn.innerHTML = svg(I.maximize2, 14);
    layoutSeg.querySelectorAll('.sp-seg-btn').forEach(btn => {
        btn.innerHTML = svg(I[btn.getAttribute('data-layout')], 15);
    });

    // ── Custom tooltip (matches the controls bar) ──────────────────────────────
    // One shared element, repositioned under (or above, near the bottom) the
    // hovered [data-tip] control and clamped inside the card.
    const tip = document.createElement('div');

    tip.className = 'sp-tip';
    card.appendChild(tip);

    /** Show the tooltip for a control, flipping above if it'd leave the card. */
    const showTip = el => {
        const text = el.getAttribute('data-tip');

        if (!text) {
            return;
        }
        tip.textContent = text;

        const r = el.getBoundingClientRect();
        const cardR = card.getBoundingClientRect();
        const half = tip.offsetWidth / 2;
        let top = r.bottom - cardR.top + 6;

        if (top + tip.offsetHeight > cardR.height - 2) {
            top = r.top - cardR.top - tip.offsetHeight - 6;
        }
        const cx = Math.max(half + 4,
            Math.min(r.left - cardR.left + (r.width / 2), cardR.width - half - 4));

        tip.style.left = `${cx}px`;
        tip.style.top = `${top}px`;
        tip.classList.add('is-on');
    };

    /** Hide the tooltip. */
    const hideTip = () => tip.classList.remove('is-on');

    /** Wire a control's hover to the custom tooltip. */
    const attachTip = el => {
        el.addEventListener('mouseenter', () => showTip(el));
        el.addEventListener('mouseleave', hideTip);
    };

    [ ...layoutSeg.querySelectorAll('.sp-seg-btn'), autoBtn, countEl, closeBtn, backBtn ].forEach(attachTip);

    // ── Selectors ────────────────────────────────────────────────────────────
    /** The roster entry for an id (or null). */
    const byId = id => roster.find(p => p.id === id) || null;

    /** The participant currently spotlighted (resolves a stale/empty selId). */
    const spotlight = () => byId(selId) || roster[0] || null;

    /** Escape a participant id for use in a CSS attribute selector. */
    const cssEsc = s => String(s).replace(/["\\]/g, '\\$&');

    /** The on-stage participant ids for the current layout. */
    const stageIds = () => {
        if (!roster.length) {
            return [];
        }
        if (layout === 'grid') {
            return roster.slice(0, 4).map(p => p.id);
        }
        const sp = spotlight();

        if (layout === 'split') {
            const next = roster.find(p => p.id !== sp.id);

            return next ? [ sp.id, next.id ] : [ sp.id ];
        }

        return [ sp.id ];
    };

    // ── Tile builders ──────────────────────────────────────────────────────────

    /**
     * Build the avatar node for a participant (real avatar image, else gradient
     * initials). Built via the DOM (img.src / textContent), NOT an innerHTML
     * string — avatarURL/initials derive from a remote participant's display
     * name/identity, so interpolating them into HTML would be an XSS sink.
     */
    const buildAvatar = (p, big) => {
        if (p.avatarURL) {
            const img = document.createElement('img');

            img.className = 'sp-av-img';
            img.alt = '';
            img.src = p.avatarURL; // property assignment — not parsed as HTML

            return img;
        }
        const span = document.createElement('span');

        span.className = big ? 'sp-av sp-av--big' : 'sp-av';
        span.style.background = p.avatarColor || '#555';
        span.textContent = p.initials || '';

        return span;
    };

    /**
     * Set the avatar wrap's content only when it actually changes. render() now
     * runs at ~10 Hz (audio levels), so rebuilding the avatar DOM unconditionally
     * would re-create the <img> every frame — wasteful and prone to flicker.
     */
    const setAvatar = (avWrap, p, big) => {
        const key = `${big ? 'b:' : ''}${p.avatarURL || `${p.avatarColor || ''}|${p.initials || ''}`}`;

        if (avWrap.dataset.av !== key) {
            avWrap.dataset.av = key;
            avWrap.replaceChildren(buildAvatar(p, big));
        }
    };

    /**
     * Toggle an element's visibility and fill its innerHTML only once (first time
     * shown, while still empty), from the lazy `html()` builder. render() runs at
     * ~10 Hz, so re-setting innerHTML every frame would restart the inner CSS
     * animation (hand-bounce, dot pulse); `html` is lazy so hidden elements don't
     * even build the markup.
     */
    const setOnce = (el, show, html) => {
        el.classList.toggle('hidden', !show);
        if (show && !el.firstChild) {
            el.innerHTML = html();
        }
    };

    /** Update a stage tile in place (video/avatar, name, mic, speaking, badge, selection). */
    const updateStageTile = (el, p, big) => {
        const vid = el.querySelector('.sp-vid');
        const avWrap = el.querySelector('.sp-av-wrap');
        const frame = frames[p.id];

        if (p.hasVideo && frame) {
            vid.src = frame;
            vid.style.display = 'block';
            avWrap.style.display = 'none';
        } else {
            vid.style.display = 'none';
            avWrap.style.display = 'flex';
            setAvatar(avWrap, p, big);
        }

        const sp = spotlight();

        el.classList.toggle('selected', Boolean(sp) && p.id === sp.id);

        const nameEl = el.querySelector('.sp-name');

        nameEl.textContent = p.name || '';
        if (p.id === 'local') {
            const you = document.createElement('span');

            you.className = 'sp-you';
            you.textContent = ' - you';
            nameEl.appendChild(you);
        }

        // Mic: small tiles show it inline in the label; the big tile shows it in a
        // corner box (matches the design's StageTile). The icon only changes when
        // hasAudio flips, so rebuild it then — not every ~10 Hz render.
        const mic = el.querySelector('.sp-mic');
        const micbox = el.querySelector('.sp-micbox');

        if (el.dataset.mic !== String(p.hasAudio)) {
            el.dataset.mic = String(p.hasAudio);
            const micIcon = svg(p.hasAudio ? I.micOn : I.micOff, big ? 15 : 11);

            mic.innerHTML = micIcon;
            micbox.innerHTML = micIcon;
        }
        mic.classList.toggle('off', !p.hasAudio);
        micbox.classList.toggle('off', !p.hasAudio);

        const speak = el.querySelector('.sp-speak');

        speak.classList.toggle('on', Boolean(p.speaking));
        speak.style.setProperty('--lvl', String(p.speaking ? p.audioLevel || 0 : 0));

        setOnce(el.querySelector('.sp-badge'), big && auto, () => '<span class="sp-dot"></span> FOLLOWING');
        setOnce(el.querySelector('.sp-hand'), p.raisedHand, () => svg(I.hand, 17));
    };

    /** Build a stage tile element for participant `p`. `big` = spotlight size. */
    const stageTile = (p, big) => {
        const el = document.createElement('div');

        el.className = big ? 'sp-tile sp-tile--big' : 'sp-tile';
        el.setAttribute('data-id', p.id);
        el.innerHTML
            = '<img class="sp-vid" alt="">'
            + '<span class="sp-av-wrap"></span>'
            + '<span class="sp-speak"><span class="sp-bars"><i></i><i></i><i></i></span></span>'
            + '<span class="sp-corner"><span class="sp-badge hidden"></span><span class="sp-hand hidden"></span></span>'
            + '<span class="sp-label"><span class="sp-mic"></span><span class="sp-name"></span></span>'
            + '<span class="sp-micbox"></span>';
        updateStageTile(el, p, big);

        return el;
    };

    /** Update a filmstrip thumbnail in place. */
    const updateThumb = (el, p) => {
        const vid = el.querySelector('.sp-vid');
        const avWrap = el.querySelector('.sp-av-wrap');
        const frame = frames[p.id];

        if (FILMSTRIP_VIDEO && p.hasVideo && frame) {
            vid.src = frame;
            vid.style.display = 'block';
            avWrap.style.display = 'none';
        } else {
            vid.style.display = 'none';
            avWrap.style.display = 'flex';
            setAvatar(avWrap, p, false);
        }

        const sp = spotlight();

        el.classList.toggle('selected', Boolean(sp) && p.id === sp.id);
        el.querySelector('.sp-thumb-speak').classList.toggle('on', Boolean(p.speaking));

        setOnce(el.querySelector('.sp-thumb-hand'), p.raisedHand, () => svg(I.hand, 13));
    };

    /** Build a filmstrip thumbnail for participant `p`. */
    const thumb = p => {
        const el = document.createElement('button');

        el.className = 'sp-thumb';
        el.setAttribute('data-id', p.id);
        el.setAttribute('data-tip', p.name || '');
        el.innerHTML
            = '<img class="sp-vid" alt="">'
            + '<span class="sp-av-wrap"></span>'
            + '<span class="sp-thumb-speak"></span>'
            + '<span class="sp-thumb-hand hidden"></span>';
        attachTip(el);
        updateThumb(el, p);

        return el;
    };

    // ── Render ───────────────────────────────────────────────────────────────

    /** Pick the spotlight when following the active speaker. */
    const applyAutoFollow = () => {
        if (!auto) {
            return;
        }
        const dom = roster.find(p => p.dominantSpeaker);

        if (dom) {
            selId = dom.id;
        } else if (!byId(selId)) {
            selId = (byId('local') ? 'local' : roster[0] && roster[0].id) || null;
        }
    };

    /** Rebuild the body for the current layout (called on structural change). */
    const buildBody = (ids, inFilmstrip) => {
        body.className = `sp-body sp-body--${effLayout}`;
        body.innerHTML = '';

        const stage = document.createElement('div');

        stage.className = 'sp-stage';
        ids.forEach((id, i) => {
            const p = byId(id);

            if (p) {
                stage.appendChild(stageTile(p, effLayout === 'single' && i === 0));
            }
        });
        body.appendChild(stage);

        if (inFilmstrip) {
            const strip = document.createElement('div');

            strip.className = 'sp-film';
            roster.forEach(p => strip.appendChild(thumb(p)));
            body.appendChild(strip);
        }
    };

    /** Update the existing body in place (metadata / frames, no structural change). */
    const updateBody = (ids, inFilmstrip) => {
        ids.forEach((id, i) => {
            const el = body.querySelector(`.sp-stage .sp-tile[data-id="${cssEsc(id)}"]`);
            const p = byId(id);

            if (el && p) {
                updateStageTile(el, p, effLayout === 'single' && i === 0);
            }
        });
        if (inFilmstrip) {
            roster.forEach(p => {
                const el = body.querySelector(`.sp-film .sp-thumb[data-id="${cssEsc(p.id)}"]`);

                if (el) {
                    updateThumb(el, p);
                }
            });
        }
    };

    /** Update the header — layout seg, Auto/Pinned, count, pill badge. */
    const renderHeader = alone => {
        // Solo: nothing to switch between or follow, so hide the seg + Auto toggle.
        layoutSeg.classList.toggle('hidden', alone);
        autoBtn.classList.toggle('hidden', alone);

        layoutSeg.querySelectorAll('.sp-seg-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-layout') === layout);
        });
        autoBtn.classList.toggle('on', auto);
        if (auto !== lastAuto) {
            lastAuto = auto;
            autoBtn.innerHTML = `${svg(auto ? I.radio : I.pin, 13)}<span>${auto ? 'Auto' : 'Pinned'}</span>`;
            autoBtn.setAttribute('data-tip', auto ? 'Following the active speaker' : 'Pinned to one person');
        }
        if (total !== lastTotal) {
            lastTotal = total;
            countEl.innerHTML = `${svg(I.users, 14)}<span>${total}</span>`;
        }

        pillBadge.classList.toggle('hidden', total <= 0);
        pillBadge.textContent = String(total);
    };

    /** Report the on-stage set to main (so it captures frames for them) when it changes. */
    const reportStageIfChanged = ids => {
        const key = ids.join(',');

        if (key !== lastStageKey) {
            lastStageKey = key;
            api.reportStage?.(ids);
        }
    };

    /** Measure the card and ask main to resize the window to fit. */
    const syncSize = () => {
        if (pillMode) {
            return;
        }
        requestAnimationFrame(() => {
            const w = card.offsetWidth;
            const h = card.offsetHeight;
            const key = `${w}x${h}`;

            if (w && h && key !== lastSize) {
                lastSize = key;
                api.setSize?.(w, h);
            }
        });
    };

    /** Full render — reconciles structure on layout/selection change, updates in place otherwise. */
    const render = () => {
        if (!roster.length) {
            return;
        }
        applyAutoFollow();

        // When you're the only one here, the single spotlight fills the card and
        // the layout switcher / filmstrip are hidden — nothing to arrange.
        const alone = roster.length <= 1;

        effLayout = alone ? 'single' : layout;

        const ids = alone ? [ roster[0].id ] : stageIds();
        const inFilmstrip = effLayout === 'single' && !alone;
        const film = inFilmstrip ? roster.map(p => p.id).join(',') : '';
        const structKey = `${effLayout}|${alone}|${ids.join(',')}|${film}`;

        if (structKey === lastStructKey) {
            updateBody(ids, inFilmstrip);
        } else {
            lastStructKey = structKey;
            buildBody(ids, inFilmstrip);
        }

        renderHeader(alone);
        reportStageIfChanged(ids);
        syncSize();
    };

    // ── Controls ───────────────────────────────────────────────────────────────
    /** Persist the current layout + auto prefs. */
    const persist = () => api.saveSettings?.({ layout,
        auto });

    /** Switch the body layout (single / split / grid). */
    const setLayout = next => {
        if (next !== layout) {
            layout = next;
            persist();
            render();

            // Smooth rise-in on layout switch (render() just rebuilt the body).
            Array.from(body.children).forEach(el => el.classList.add('sp-rise'));
        }
    };

    /** Toggle Auto-follow; re-acquiring the active speaker when re-enabled. */
    const toggleAuto = () => {
        auto = !auto;
        if (auto) {
            selId = null;
        }
        persist();
        render();
    };

    /** Promote a participant to the spotlight (switches to Pinned). */
    const pick = id => {
        selId = id;
        auto = false;
        persist();
        render();
    };

    layoutSeg.addEventListener('click', e => {
        const btn = e.target.closest('.sp-seg-btn');

        if (btn) {
            setLayout(btn.getAttribute('data-layout'));
        }
    });
    autoBtn.addEventListener('click', toggleAuto);
    closeBtn.addEventListener('click', () => api.close?.());
    backBtn.addEventListener('click', () => api.openChat?.(false));

    // Tap a filmstrip thumb or a non-spotlighted stage tile to promote that person.
    body.addEventListener('click', e => {
        const thumbEl = e.target.closest('.sp-thumb');

        if (thumbEl) {
            pick(thumbEl.getAttribute('data-id'));

            return;
        }
        const tile = e.target.closest('.sp-tile');

        if (tile && !tile.classList.contains('sp-tile--big')) {
            pick(tile.getAttribute('data-id'));
        }
    });

    // ── Pill mode ────────────────────────────────────────────────────────────
    api.onEnterPillMode?.(() => {
        pillMode = true;
        card.classList.add('hiding');
        setTimeout(() => {
            card.classList.add('hidden');
            card.classList.remove('hiding');
            pillOverlay.classList.add('active');
            requestAnimationFrame(() => pillBtn.classList.add('visible'));
        }, 200);
    });
    api.onEnterPanelMode?.(() => {
        pillMode = false;
        pillBtn.classList.remove('visible');
        setTimeout(() => {
            pillOverlay.classList.remove('active');
            card.classList.remove('hidden');
            card.classList.add('hiding');
            requestAnimationFrame(() => {
                card.classList.remove('hiding');
                lastSize = '';
                syncSize();
            });
        }, 200);
    });

    // ── Drag (whole card / pill, except interactive controls) ──────────────────
    const DRAG_IGNORE = 'button, .sp-thumb, .sp-tile';
    const THRESH = 5;
    let dragPending = false;
    let dragging = false;
    let startX = 0;
    let startY = 0;

    card.addEventListener('mousedown', e => {
        if (e.button !== 0 || e.target.closest(DRAG_IGNORE)) {
            return;
        }
        dragPending = true;
        dragging = false;
        startX = e.screenX;
        startY = e.screenY;
        e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
        if (!dragPending || dragging) {
            return;
        }
        if (Math.abs(e.screenX - startX) > THRESH || Math.abs(e.screenY - startY) > THRESH) {
            dragging = true;
            api.startWindowDrag?.();
        }
    });
    window.addEventListener('mouseup', () => {
        if (dragging) {
            api.stopWindowDrag?.();
        }
        dragPending = false;
        dragging = false;
    });

    // Pill drag + click-to-reopen.
    let pillDragging = false;
    let pillMoved = false;
    let pStartX = 0;
    let pStartY = 0;

    pillBtn.addEventListener('mousedown', e => {
        if (e.button !== 0) {
            return;
        }
        pillDragging = true;
        pillMoved = false;
        pStartX = e.screenX;
        pStartY = e.screenY;
        api.startWindowDrag?.();
        e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
        if (!pillDragging || pillMoved) {
            return;
        }
        if (Math.abs(e.screenX - pStartX) > THRESH || Math.abs(e.screenY - pStartY) > THRESH) {
            pillMoved = true;
        }
    });
    window.addEventListener('mouseup', () => {
        if (!pillDragging) {
            return;
        }
        pillDragging = false;
        api.stopWindowDrag?.();
        if (!pillMoved) {
            api.reopen?.();
        }
    });

    // ── Data wiring ────────────────────────────────────────────────────────────
    api.onParticipantsUpdate?.(data => {
        roster = data?.roster || data?.participants || [];
        total = data?.totalParticipantCount || roster.length;

        // Drop cached frames for participants who have left, so the map doesn't
        // grow unbounded over a long session.
        const present = new Set(roster.map(p => p.id));

        for (const id of Object.keys(frames)) {
            if (!present.has(id)) {
                delete frames[id];
            }
        }
        render();
    });
    api.onFrame?.(f => {
        if (!f?.id) {
            return;
        }
        frames[f.id] = f.data;

        const el = body.querySelector(`.sp-tile[data-id="${cssEsc(f.id)}"] .sp-vid`);

        if (el) {
            el.src = f.data;
            el.style.display = 'block';
            const wrap = el.parentNode.querySelector('.sp-av-wrap');

            if (wrap) {
                wrap.style.display = 'none';
            }
        }
    });
    api.onSettings?.(s => {
        if (s?.layout === 'single' || s?.layout === 'split' || s?.layout === 'grid') {
            layout = s.layout;
        }
        if (typeof s?.auto === 'boolean') {
            auto = s.auto;
        }
        render();
    });

    // Host theme → live recolour. Only base accent/danger/warn colours are
    // sent; the CSS derives translucent variants (--action-soft) from them via
    // color-mix. Host tokens map onto the Spotlight palette's own var names.
    api.onThemeUpdate?.(t => {
        if (!t) {
            return;
        }
        const root = document.documentElement.style;

        if (t.accent) {
            root.setProperty('--action', t.accent);
        }
        if (t.accentHover) {
            root.setProperty('--action-glyph', t.accentHover);
        }
        if (t.danger) {
            root.setProperty('--danger', t.danger);
        }
        if (t.dangerIcon) {
            root.setProperty('--danger-hover', t.dangerIcon);
        }
        if (t.warn) {
            root.setProperty('--warn', t.warn);
        }
    });

    renderHeader(false);
})();
