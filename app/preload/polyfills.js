const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (typeof Request === 'undefined') {
    global.Request = class Request {
        /**
         * @param {string|Request} input - URL string or Request to copy.
         * @param {Object} [init] - Optional request init options.
         */
        constructor(input, init = {}) {
            this.url = typeof input === 'string' ? input : input.url;
            this.method = (init.method || 'GET').toUpperCase();
            this.headers = new (global.Headers || Object)(init.headers);
            this.body = init.body || null;
            this.credentials = init.credentials || 'same-origin';
            this.mode = init.mode || 'cors';
        }
    };
}

if (typeof Headers === 'undefined') {
    global.Headers = class Headers {
        /**
         * @param {Headers|Array|Object} [init] - Initial header values.
         */
        constructor(init) {
            this._map = new Map();

            if (init) {
                if (init instanceof Headers) {
                    for (const [ key, value ] of init._map) {
                        this._map.set(key, value);
                    }
                } else if (Array.isArray(init)) {
                    for (const [ key, value ] of init) {
                        this._map.set(key, value);
                    }
                } else if (typeof init === 'object') {
                    for (const key in init) {
                        if (Object.prototype.hasOwnProperty.call(init, key)) {
                            this._map.set(key, init[key]);
                        }
                    }
                }
            }
        }

        /**
         * Appends a value to the header, combining with any existing value.
         *
         * @param {string} name - Header name.
         * @param {string} value - Header value to append.
         * @returns {void}
         */
        append(name, value) {
            const existing = this._map.get(name);

            if (existing) {
                this._map.set(name, `${existing}, ${value}`);
            } else {
                this._map.set(name, value);
            }
        }

        /**
         * Removes a header.
         *
         * @param {string} name - Header name.
         * @returns {void}
         */
        delete(name) {
            this._map.delete(name);
        }

        /**
         * Gets a header value.
         *
         * @param {string} name - Header name.
         * @returns {?string} The header value, or null if absent.
         */
        get(name) {
            return this._map.get(name) || null;
        }

        /**
         * Checks whether a header exists.
         *
         * @param {string} name - Header name.
         * @returns {boolean} True if the header exists.
         */
        has(name) {
            return this._map.has(name);
        }

        /**
         * Sets a header value, replacing any existing value.
         *
         * @param {string} name - Header name.
         * @param {string} value - Header value.
         * @returns {void}
         */
        set(name, value) {
            this._map.set(name, value);
        }

        /**
         * @returns {Iterator} Iterator over [name, value] entries.
         */
        entries() {
            return this._map.entries();
        }

        /**
         * @returns {Iterator} Iterator over header names.
         */
        keys() {
            return this._map.keys();
        }

        /**
         * @returns {Iterator} Iterator over header values.
         */
        values() {
            return this._map.values();
        }

        /**
         * Invokes a callback for each header.
         *
         * @param {Function} callback - Called with (value, key, headers).
         * @param {*} [thisArg] - Value to use as `this` in the callback.
         * @returns {void}
         */
        forEach(callback, thisArg) {
            this._map.forEach((value, key) => {
                callback.call(thisArg, value, key, this);
            });
        }

        /**
         * @returns {Iterator} Iterator over [name, value] entries.
         * @yields {Array} A [name, value] pair.
         */
        *[Symbol.iterator]() {
            for (const [ key, value ] of this._map) {
                yield [ key, value ];
            }
        }
    };
}


if (typeof FormData === 'undefined') {
    if (typeof window !== 'undefined' && window.FormData) {
        global.FormData = window.FormData;
    } else {
        try {
            /**
             * Minimal FormData polyfill that serializes parts into a
             * multipart/form-data payload for fetch/XHR in the preload.
             */
            class FormDataShim {
                /**
                 * Initializes an empty multipart payload with a unique boundary.
                 */
                constructor() {
                    this.boundary = `----ElectronFormDataShimBoundary${crypto.randomBytes(16).toString('hex')}`;
                    this.parts = [];
                }

                /**
                 * Appends a field or file part to the form.
                 *
                 * @param {string} key - Field name.
                 * @param {*} value - Field value or a file-like object with a `path`.
                 * @param {string} [filename] - Optional file name override.
                 * @returns {void}
                 */
                append(key, value, filename) {
                    let buffer;
                    let header = '';
                    const disposition = `Content-Disposition: form-data; name="${key}"`;

                    if (value && value.path && (value.size !== undefined || value.type)) {
                        try {
                            buffer = fs.readFileSync(value.path);
                            const fname = filename || value.name || path.basename(value.path);

                            header = `${disposition}; filename="${fname}"\r\n`;
                            const contentType = value.type || 'application/octet-stream';

                            header += `Content-Type: ${contentType}\r\n`;
                        } catch (e) {
                            console.warn('FormDataShim: Failed to read file', value.path, e);

                            return;
                        }
                    } else {
                        buffer = Buffer.from(String(value));
                        header = `${disposition}\r\n`;
                    }

                    this.parts.push({ header: `${header}\r\n`,
                        body: buffer });
                }

                /**
                 * Serializes all appended parts into a single multipart body.
                 *
                 * @returns {Buffer} The encoded multipart/form-data payload.
                 */
                getPayload() {
                    const chunks = [];

                    for (const part of this.parts) {
                        chunks.push(Buffer.from(`--${this.boundary}\r\n`));
                        chunks.push(Buffer.from(part.header));
                        chunks.push(part.body);
                        chunks.push(Buffer.from('\r\n'));
                    }
                    chunks.push(Buffer.from(`--${this.boundary}--\r\n`));

                    return Buffer.concat(chunks);
                }
            }

            global.FormData = FormDataShim;

            // Patch fetch
            const originalFetch = window.fetch;

            window.fetch = (input, init) => {
                if (init && init.body && init.body instanceof FormDataShim) {
                    init.headers = {
                        ...init.headers,
                        'Content-Type': `multipart/form-data; boundary=${init.body.boundary}`
                    };
                    init.body = init.body.getPayload();
                }

                return originalFetch(input, init);
            };

            // Patch XMLHttpRequest
            const originalXhrSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.send = function(body) {
                if (body instanceof FormDataShim) {
                    const payload = body.getPayload();

                    this.setRequestHeader('Content-Type', `multipart/form-data; boundary=${body.boundary}`);

                    return originalXhrSend.call(this, payload);
                }

                return originalXhrSend.call(this, body);
            };

        } catch (e) {
            console.warn('Failed to polyfill FormData:', e);
        }
    }
}
