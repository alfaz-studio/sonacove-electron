const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const AZURE_CONFIG = {
    endpoint: 'https://eus.codesigning.azure.net/',
    accountName: 'sonacovemeets',
    certificateProfileName: 'SonacoveMeetsDesktopApp'
};

const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

/**
 * Load Azure Trusted Signing credentials from a local file or env vars.
 */
function loadAzureCredentials() {
    const possiblePaths = [
        path.join(__dirname, '.azure-credentials.json'),
        path.join(process.cwd(), '.azure-credentials.json'),
        path.join(process.env.USERPROFILE || process.env.HOME, '.azure-credentials.json')
    ];

    for (const credPath of possiblePaths) {
        if (fs.existsSync(credPath)) {
            console.log(`   Loading credentials from: ${credPath}`);

            return JSON.parse(fs.readFileSync(credPath, 'utf8'));
        }
    }

    if (process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET
      && process.env.AZURE_TENANT_ID && process.env.AZURE_SUBSCRIPTION_ID) {
        console.log('   Loading credentials from environment variables');

        return {
            clientId: process.env.AZURE_CLIENT_ID,
            clientSecret: process.env.AZURE_CLIENT_SECRET,
            tenantId: process.env.AZURE_TENANT_ID,
            subscriptionId: process.env.AZURE_SUBSCRIPTION_ID
        };
    }

    throw new Error('Azure credentials not found!');
}

/**
 * Sign one file via the Microsoft `sign` CLI (Azure Trusted Signing).
 */
function signWithAzure(filePath, credentials) {
    return new Promise((resolve, reject) => {
        const args = [
            'code', 'trusted-signing',
            '-tse', AZURE_CONFIG.endpoint,
            '-tsa', AZURE_CONFIG.accountName,
            '-tscp', AZURE_CONFIG.certificateProfileName,
            '-fd', 'SHA256',
            '-t', TIMESTAMP_URL,
            filePath
        ];

        // Get the dotnet tools directory
        let signToolPath = 'sign';
        const userProfile = process.env.USERPROFILE || process.env.HOME;
        const toolsDir = path.join(userProfile, '.dotnet', 'tools');
        const signExe = path.join(toolsDir, process.platform === 'win32' ? 'sign.exe' : 'sign');

        if (fs.existsSync(signExe)) {
            signToolPath = signExe;
            console.log(`   Using sign tool: ${signToolPath}`);
        }

        const signProcess = spawn(signToolPath, args, {
            stdio: 'inherit',
            env: {
                ...process.env,
                AZURE_TENANT_ID: credentials.tenantId,
                AZURE_CLIENT_ID: credentials.clientId,
                AZURE_CLIENT_SECRET: credentials.clientSecret,
                PATH: `${toolsDir}${path.delimiter}${process.env.PATH}`
            }
        });

        signProcess.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Sign tool exited with code ${code}`));
            }
        });

        signProcess.on('error', error => {
            reject(error);
        });
    });
}

/**
 * Sign an artifact if present, with friendly skip/error logging.
 */
async function signFile(filePath, credentials) {
    if (!fs.existsSync(filePath)) {
        console.log(`   ⏭️  Skipped (not found): ${path.basename(filePath)}`);

        return;
    }

    console.log(`   🔐 Signing: ${path.basename(filePath)}`);

    try {
        await signWithAzure(filePath, credentials);
        console.log(`   ✅ Signed: ${path.basename(filePath)}`);
    } catch (error) {
        throw new Error(`Failed to sign ${path.basename(filePath)}: ${error.message}`);
    }
}

/**
 * Best-effort embed of the app icon into an executable via rcedit.
 */
async function embedIcon(exePath, iconPath) {
    try {
        let rcedit;

        try {
            rcedit = require('rcedit');
        } catch (e) {
            console.warn('   ⚠️  rcedit not available, skipping icon embedding');

            return;
        }

        if (!fs.existsSync(exePath)) {
            console.log(`   ⏭️  Skipped (exe not found): ${path.basename(exePath)}`);

            return;
        }

        if (!fs.existsSync(iconPath)) {
            console.log(`   ⏭️  Skipped (icon not found): ${path.basename(iconPath)}`);

            return;
        }

        console.log(`   📎 Embedding icon in: ${path.basename(exePath)}`);

        // Try different ways to call rcedit
        let success = false;

        // Method 1: Direct function call
        if (typeof rcedit === 'function') {
            try {
                await rcedit(exePath, { icon: iconPath });
                success = true;
            } catch (e) {
                console.log(`   ⏭️  Method 1 failed: ${e.message}`);
            }
        }

        // Method 2: rcedit.default
        if (!success && rcedit.default && typeof rcedit.default === 'function') {
            try {
                await rcedit.default(exePath, { icon: iconPath });
                success = true;
            } catch (e) {
                console.log(`   ⏭️  Method 2 failed: ${e.message}`);
            }
        }

        // Method 3: rcedit.edit
        if (!success && typeof rcedit.edit === 'function') {
            try {
                await rcedit.edit(exePath, { icon: iconPath });
                success = true;
            } catch (e) {
                console.log(`   ⏭️  Method 3 failed: ${e.message}`);
            }
        }

        // Method 4: Try all properties that might be functions
        if (!success) {
            for (const key of Object.keys(rcedit)) {
                if (typeof rcedit[key] !== 'function') {
                    continue;
                }
                try {
                    await rcedit[key](exePath, { icon: iconPath });
                    success = true;
                    console.log(`   ✅ Icon embedded using method: ${key}`);
                    break;
                } catch (e) {
                    // Try next method
                }
            }
        }

        if (success) {
            console.log(`   ✅ Icon embedded: ${path.basename(exePath)}`);
        } else {
            console.warn('   ⚠️  Could not determine how to call rcedit - skipping icon embedding');
        }
    } catch (error) {
        console.warn(`   ⚠️  Could not embed icon: ${error.message}`);
    }
}

/**
 * Install or update the Microsoft `sign` global dotnet tool.
 */
function installSignTool() {
    return new Promise((resolve, reject) => {
        console.log('   📦 Installing Microsoft sign tool...');

        const install = spawn('dotnet', [ 'tool', 'install', '--global', 'sign', '--prerelease' ], {
            stdio: 'inherit',
            shell: true
        });

        install.on('close', code => {
            if (code === 0) {
                console.log('   ✅ Sign tool installed\n');
                resolve();
            } else {
                console.log('   Attempting to update existing sign tool...');
                const update = spawn('dotnet', [ 'tool', 'update', '--global', 'sign', '--prerelease' ], {
                    stdio: 'inherit',
                    shell: true
                });

                update.on('close', updateCode => {
                    if (updateCode === 0) {
                        console.log('   ✅ Sign tool updated\n');
                        resolve();
                    } else {
                        reject(new Error('Failed to install/update sign tool'));
                    }
                });

                update.on('error', error => {
                    reject(error);
                });
            }
        });

        install.on('error', error => {
            reject(error);
        });
    });
}

/**
 * Verify the .NET SDK is available (required by the `sign` tool).
 */
function checkDotNetSdk() {
    return new Promise((resolve, reject) => {
        console.log('🔍 Checking .NET SDK...');

        const check = spawn('dotnet', [ '--version' ], { shell: true,
            stdio: 'pipe' });
        let version = '';

        check.stdout.on('data', data => {
            version += data.toString();
        });

        check.on('close', code => {
            if (code !== 0) {
                reject(new Error('.NET SDK not found. Install from: https://dotnet.microsoft.com/download'));

                return;
            }

            console.log(`   ✅ .NET SDK found (${version.trim()})`);
            resolve();
        });

        check.on('error', error => {
            reject(error);
        });
    });
}

// Prepare the signing toolchain (credentials + the Microsoft `sign` CLI) exactly
// once per build, regardless of how many files electron-builder asks us to sign
// (it calls the sign hook for both the installer and the uninstaller).
let signingSetupPromise = null;

/**
 * Prepare the signing toolchain once per build (memoized).
 */
function ensureSigningSetup() {
    if (signingSetupPromise === null) {
        signingSetupPromise = (async () => {
            console.log('\n═══════════════════════════════════════════════════');
            console.log('   Azure Trusted Signing - Sonacove Meets');
            console.log('═══════════════════════════════════════════════════\n');

            console.log('📋 Loading Azure credentials...');
            const credentials = loadAzureCredentials();

            console.log('   ✅ Credentials loaded\n');

            await checkDotNetSdk();

            // Probe the dotnet-tools install location directly. A naive
            // `spawn('sign', ['--version'], { shell: true })` is unreliable on
            // the Windows runner: (1) cmd.exe's cwd-first PATH lookup can match
            // a local `sign.*` file and hang; (2) when the tool is absent cmd
            // writes to stderr but may exit 0, so the tool is never installed
            // and the later sign call hits `spawn sign ENOENT`.
            console.log('   Checking sign tool...');
            const userProfile = process.env.USERPROFILE || process.env.HOME;
            const toolsDir = path.join(userProfile, '.dotnet', 'tools');
            const signExe = path.join(toolsDir, process.platform === 'win32' ? 'sign.exe' : 'sign');

            if (fs.existsSync(signExe)) {
                console.log('   ✅ Sign tool found\n');
            } else {
                await installSignTool();
            }

            return credentials;
        })().catch(error => {
            // Reset so a retry can re-attempt setup, then surface the failure.
            signingSetupPromise = null;
            throw error;
        });
    }

    return signingSetupPromise;
}

/**
 * electron-builder Windows sign hook (`build.win.signtoolOptions.sign`).
 *
 * electron-builder invokes this for every artifact it signs during the build —
 * notably the NSIS installer and uninstaller — *before* it computes the update
 * metadata (latest.yml). Signing here (rather than in afterAllArtifactBuild)
 * means latest.yml is generated over the already-signed installer, so its
 * checksum is correct and we no longer hand-roll latest.yml in CI.
 *
 * `build.win.signtoolOptions.signingHashAlgorithms` is pinned to ['sha256'] so
 * this runs once per file (Azure Trusted Signing is SHA-256 only).
 */
exports.sign = async function(configuration) {
    if (process.platform !== 'win32') {
        console.log('⏭️  Skipping code signing (not running on Windows)');

        return;
    }

    const credentials = await ensureSigningSetup();

    await signFile(configuration.path, credentials);
};

/**
 * electron-builder afterPack hook (`build.afterPack`).
 *
 * With `signAndEditExecutable: false`, electron-builder does not edit the packed
 * executable, so we embed the app icon ourselves here. Signing of the app exe is
 * intentionally not done (matching historical behaviour); the installer — the
 * artifact users download and that latest.yml describes — is signed via the
 * sign hook above.
 */
exports.default = async function(context) {
    if (process.platform !== 'win32') {
        console.log('⏭️  Skipping icon embedding (not running on Windows)');

        return;
    }

    if (!context.appOutDir) {
        return;
    }

    const appOutDir = context.appOutDir;

    console.log(`\n📎 Embedding icon into executable in: ${appOutDir}`);

    const iconPath = path.join(__dirname, 'resources', 'icon.ico');
    const mainExePath = path.join(appOutDir, 'Sonacove Meets.exe');

    await embedIcon(mainExePath, iconPath);
};
