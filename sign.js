const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const AZURE_CONFIG = {
    endpoint: 'https://eus.codesigning.azure.net/',
    accountName: 'sonacovemeets',
    certificateProfileName: 'SonacoveMeetsDesktopApp'
};

const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

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

async function signWithAzure(filePath, credentials) {
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

        const signProcess = spawn('sign', args, {
            stdio: 'inherit',
            env: {
                ...process.env,
                AZURE_TENANT_ID: credentials.tenantId,
                AZURE_CLIENT_ID: credentials.clientId,
                AZURE_CLIENT_SECRET: credentials.clientSecret
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

async function embedIcon(exePath, iconPath) {
    try {
        let rcedit;
        try {
            rcedit = require('rcedit');
        } catch (e) {
            console.warn(`   ⚠️  rcedit not available, skipping icon embedding`);
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
        
        let success = false;
        
        if (typeof rcedit === 'function') {
            try {
                await rcedit(exePath, { icon: iconPath });
                success = true;
            } catch (e) {
                console.log(`   ⏭️  Method 1 failed: ${e.message}`);
            }
        }
        
        if (!success && rcedit.default && typeof rcedit.default === 'function') {
            try {
                await rcedit.default(exePath, { icon: iconPath });
                success = true;
            } catch (e) {
                console.log(`   ⏭️  Method 2 failed: ${e.message}`);
            }
        }
        
        if (!success && typeof rcedit.edit === 'function') {
            try {
                await rcedit.edit(exePath, { icon: iconPath });
                success = true;
            } catch (e) {
                console.log(`   ⏭️  Method 3 failed: ${e.message}`);
            }
        }
        
        if (!success) {
            for (const key of Object.keys(rcedit)) {
                if (typeof rcedit[key] === 'function') {
                    try {
                        await rcedit[key](exePath, { icon: iconPath });
                        success = true;
                        console.log(`   ✅ Icon embedded using method: ${key}`);
                        break;
                    } catch (e) {
                        // Try next
                    }
                }
            }
        }
        
        if (success) {
            console.log(`   ✅ Icon embedded: ${path.basename(exePath)}`);
        } else {
            console.warn(`   ⚠️  Could not determine how to call rcedit`);
        }
    } catch (error) {
        console.warn(`   ⚠️  Could not embed icon: ${error.message}`);
    }
}

async function installSignTool() {
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

exports.default = async function(context) {
    if (process.platform !== 'win32') {
        console.log('⏭️  Skipping signing (not running on Windows)');
        return;
    }

    console.log('\n═══════════════════════════════════════════════════');
    console.log('   Code Signing & Icon Embedding - Sonacove Meets');
    console.log('═══════════════════════════════════════════════════\n');

    try {
        const credentials = loadAzureCredentials();
        console.log('   ✅ Credentials loaded\n');

        console.log('🔍 Checking .NET SDK...');
        await new Promise((resolve, reject) => {
            const check = spawn('dotnet', ['--version'], { shell: true, stdio: 'pipe' });
            let version = '';
            check.stdout.on('data', (data) => { version += data.toString(); });
            check.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error('.NET SDK not found'));
                } else {
                    console.log(`   ✅ .NET SDK found (${version.trim()})`);
                    resolve();
                }
            });
            check.on('error', () => {
                reject(new Error('.NET SDK not found'));
            });
        });

        console.log('   Checking sign tool...');
        await new Promise((resolve, reject) => {
            const check = spawn('sign', ['--version'], { shell: true, stdio: 'pipe' });
            let found = false;
            check.stdout.on('data', () => { found = true; });
            check.stderr.on('data', () => { found = true; });
            check.on('close', () => {
                if (found) {
                    console.log('   ✅ Sign tool found\n');
                    resolve();
                } else {
                    installSignTool().then(resolve).catch(reject);
                }
            });
            check.on('error', () => {
                installSignTool().then(resolve).catch(reject);
            });
        });

        // ONLY afterPack phase runs this (context.appOutDir exists)
        if (context.appOutDir) {
            const appOutDir = context.appOutDir;
            console.log(`📂 Processing: ${appOutDir}\n`);
            
            const files = fs.readdirSync(appOutDir);
            const exeFiles = files.filter(f => f.endsWith('.exe'));
            
            console.log(`Found ${exeFiles.length} executable(s)\n`);

            // CRITICAL ORDER:
            // 1. SIGN FIRST (before any modifications)
            console.log('🔐 Signing executables...\n');
            for (const file of exeFiles) {
                const filePath = path.join(appOutDir, file);
                await signFile(filePath, credentials);
            }

            // 2. THEN embed icon (after signing)
            console.log('\n📎 Embedding icon...\n');
            const iconPath = path.join(__dirname, 'resources', 'icon.ico');
            const mainExePath = path.join(appOutDir, 'Sonacove Meets.exe');
            await embedIcon(mainExePath, iconPath);

            // 3. Sign again after embedding (to re-sign the modified exe)
            console.log('\n🔐 Re-signing after icon embedding...\n');
            await signFile(mainExePath, credentials);

            // Sign resources
            const resourcesDir = path.join(appOutDir, 'resources');
            if (fs.existsSync(resourcesDir)) {
                const resourceFiles = fs.readdirSync(resourcesDir);
                const resourceExes = resourceFiles.filter(f => f.endsWith('.exe'));

                if (resourceExes.length > 0) {
                    console.log(`\nFound ${resourceExes.length} resource executable(s):`);
                    for (const file of resourceExes) {
                        const filePath = path.join(resourcesDir, file);
                        await signFile(filePath, credentials);
                    }
                }
            }
        }

        console.log('\n═══════════════════════════════════════════════════');
        console.log('      ✅ Signing & Icon Embedding Completed Successfully');
        console.log('═══════════════════════════════════════════════════\n');

    } catch (error) {
        console.error('\n═══════════════════════════════════════════════════');
        console.error('      ❌ Failed');
        console.error('═══════════════════════════════════════════════════');
        console.error(`Error: ${error.message}\n`);
        throw error;
    }
};
