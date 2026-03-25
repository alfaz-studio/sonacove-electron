
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (typeof Request === 'undefined') {
    global.Request = class Request {
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
                        this._map.set(key, init[key]);
                    }
                }
            }
        }

        append(name, value) {
            const existing = this._map.get(name);

            if (existing) {
                this._map.set(name, `${existing}, ${value}`);
            } else {
                this._map.set(name, value);
            }
        }

        delete(name) {
            this._map.delete(name);
        }

        get(name) {
            return this._map.get(name) || null;
        }

        has(name) {
            return this._map.has(name);
        }

        set(name, value) {
            this._map.set(name, value);
        }

        entries() {
            return this._map.entries();
        }

        keys() {
            return this._map.keys();
        }

        values() {
            return this._map.values();
        }

        forEach(callback, thisArg) {
            this._map.forEach((value, key) => {
                callback.call(thisArg, value, key, this);
            });
        }

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
            class FormDataShim {
                constructor() {
                    this.boundary = `----ElectronFormDataShimBoundary${crypto.randomBytes(16).toString('hex')}`;
                    this.parts = [];
                }

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

            window.fetch = async (input, init) => {
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
