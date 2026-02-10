const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

async function calculateSha512(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha512');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('base64')));
        stream.on('error', reject);
    });
}

async function updateLatestYml(distDir, signedFiles) {
    const yamlPath = path.join(distDir, 'latest.yml');
    
    if (!fs.existsSync(yamlPath)) {
        console.log('   ⏭️  latest.yml not found, skipping checksum update');
        return;
    }

    console.log('\n📝 Updating latest.yml with new checksums...\n');
    
    try {
        let content = fs.readFileSync(yamlPath, 'utf8');
        
        for (const filePath of signedFiles) {
            const fileName = path.basename(filePath);
            const newSha512 = await calculateSha512(filePath);
            const newSize = fs.statSync(filePath).size;

            console.log(`   📎 ${fileName}:`);
            console.log(`      SHA512: ${newSha512.substring(0, 20)}...`);
            console.log(`      Size: ${newSize} bytes\n`);

            // Update the sha512 hash in latest.yml
            const sha512Regex = new RegExp(
                `((?:path|url):\\s*${fileName.replace(/\./g, '\\.')}[\\s\\S]*?sha512:\\s*)([a-zA-Z0-9+/=]+)`,
                'g'
            );
            content = content.replace(sha512Regex, `$1${newSha512}`);

            // Update the size in latest.yml
            const sizeRegex = new RegExp(
                `((?:path|url):\\s*${fileName.replace(/\./g, '\\.')}[\\s\\S]*?size:\\s*)\\d+`,
                'g'
            );
            content = content.replace(sizeRegex, `$1${newSize}`);
        }

        fs.writeFileSync(yamlPath, content);
        console.log('   ✅ latest.yml updated successfully\n');
    } catch (error) {
        console.warn(`   ⚠️  Failed to update latest.yml: ${error.message}\n`);
    }
}

async function signWithAzure(filePath, credentials) {
    return new Promise((resolve, reject) => {
        const userProfile = process.env.USERPROFILE || process.env.HOME;
        const toolsDir = path.join(userProfile, '.dotnet', 'tools');
        const signExe = path.join(toolsDir, process.platform === 'win32' ? 'sign.exe' : 'sign');
        
        let signToolPath = 'sign';
        if (fs.existsSync(signExe)) {
            signToolPath = signExe;
        }

        const args = [
            'code', 'trusted-signing',
            '-tse', AZURE_CONFIG.endpoint,
            '-tsa', AZURE_CONFIG.accountName,
            '-tscp', AZURE_CONFIG.certificateProfileName,
            '-fd', 'SHA256',
            '-t', TIMESTAMP_URL,
            filePath  // Don't quote here - let spawn handle it
        ];

        const signProcess = spawn(signToolPath, args, {
            stdio: 'inherit',
            shell: false,  // IMPORTANT: shell: false so spawn doesn't split on spaces
            env: {
                ...process.env,
                PATH: `${toolsDir}${path.delimiter}${process.env.PATH}`,
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
        console.warn(`   ⚠️  Signing failed: ${error.message}`);
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
    return new Promise((resolve) => {
        console.log('   📦 Installing sign tool...');
        const install = spawn('dotnet', ['tool', 'install', '--global', 'sign', '--prerelease'], {
            stdio: 'inherit',
            shell: true
        });
        install.on('close', (code) => {
            if (code === 0) {
                console.log('   ✅ Sign tool installed\n');
            } else {
                console.log('   ⚠️  Failed to install sign tool\n');
            }
            resolve();
        });
        install.on('error', () => {
            console.log('   ⚠️  Error installing sign tool\n');
            resolve();
        });
    });
}

async function ensureSignToolInstalled() {
    return new Promise((resolve) => {
        const userProfile = process.env.USERPROFILE || process.env.HOME;
        const toolsDir = path.join(userProfile, '.dotnet', 'tools');
        const signExe = path.join(toolsDir, process.platform === 'win32' ? 'sign.exe' : 'sign');
        
        if (fs.existsSync(signExe)) {
            console.log('   ✅ Sign tool found\n');
            resolve();
            return;
        }

        const check = spawn('sign', ['--version'], { shell: true, stdio: 'pipe' });
        let found = false;
        
        check.stdout.on('data', () => { found = true; });
        check.stderr.on('data', () => { found = true; });
        
        check.on('close', (code) => {
            if (found || code === 0) {
                console.log('   ✅ Sign tool found\n');
                resolve();
            } else {
                installSignTool().then(resolve);
            }
        });
        
        check.on('error', () => {
            installSignTool().then(resolve);
        });
    });
}

exports.default = async function(context) {
    if (process.platform !== 'win32') {
        console.log('⏭️  Skipping (not running on Windows)');
        return;
    }

    console.log('\n═══════════════════════════════════════════════════');
    console.log('   Build Post-Processing - Sonacove Meets');
    console.log('═══════════════════════════════════════════════════\n');

    try {
        // AFTER_PACK phase
        if (context.appOutDir) {
            console.log(`📂 afterPack phase: ${context.appOutDir}\n`);
            
            const iconPath = path.join(__dirname, 'resources', 'icon.ico');
            const mainExePath = path.join(context.appOutDir, 'Sonacove Meets.exe');
            
            console.log('📎 Embedding icon...\n');
            await embedIcon(mainExePath, iconPath);
            
            console.log('\n⏭️  Skipping signing in afterPack (will sign in afterAllArtifactBuild)\n');
        } 
        // AFTER_ALL_ARTIFACT_BUILD phase
        else {
            console.log('📂 afterAllArtifactBuild phase\n');
            
            const credentials = loadAzureCredentials();
            console.log('   ✅ Credentials loaded\n');

            console.log('🔍 Checking .NET SDK...');
            await new Promise((resolve) => {
                const check = spawn('dotnet', ['--version'], { shell: true, stdio: 'pipe' });
                let version = '';
                check.stdout.on('data', (data) => { version += data.toString(); });
                check.on('close', (code) => {
                    if (code === 0) {
                        console.log(`   ✅ .NET SDK: ${version.trim()}\n`);
                    } else {
                        console.log('   ⚠️  .NET SDK not found\n');
                    }
                    resolve();
                });
                check.on('error', () => {
                    console.log('   ⚠️  .NET SDK not found\n');
                    resolve();
                });
            });

            console.log('🔍 Checking sign tool...');
            await ensureSignToolInstalled();

            const distDir = path.join(__dirname, 'dist');
            const signedFiles = [];

            if (fs.existsSync(distDir)) {
                const files = fs.readdirSync(distDir, { recursive: true });
                const exeFiles = files.filter(f => typeof f === 'string' && f.endsWith('.exe'))
                    .map(f => path.join(distDir, f));

                if (exeFiles.length > 0) {
                    console.log(`🔐 Signing ${exeFiles.length} artifact(s)...\n`);
                    for (const file of exeFiles) {
                        await signFile(file, credentials);
                        signedFiles.push(file);
                    }
                }
            }

            // UPDATE CHECKSUMS AFTER SIGNING
            if (signedFiles.length > 0) {
                await updateLatestYml(distDir, signedFiles);
            }
        }

        console.log('\n═══════════════════════════════════════════════════');
        console.log('      ✅ Completed Successfully');
        console.log('═══════════════════════════════════════════════════\n');

    } catch (error) {
        console.error('\n═══════════════════════════════════════════════════');
        console.error('      ❌ Failed');
        console.error('═══════════════════════════════════════════════════');
        console.error(`Error: ${error.message}\n`);
    }
};
