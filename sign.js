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

async function regenerateLatestYml(distDir) {
    const yamlPath = path.join(distDir, 'latest.yml');
    const installerPath = path.join(distDir, 'Sonacove-Meets-Setup.exe');
    
    if (!fs.existsSync(installerPath)) {
        console.log('   ⏭️  Installer not found, skipping latest.yml generation');
        return;
    }

    console.log('\n📝 Regenerating latest.yml with correct checksums...\n');
    
    try {
        const newSha512 = await calculateSha512(installerPath);
        const newSize = fs.statSync(installerPath).size;
        const version = require('./package.json').version;

        console.log(`   📎 Sonacove-Meets-Setup.exe:`);
        console.log(`      SHA512: ${newSha512.substring(0, 30)}...`);
        console.log(`      Size: ${newSize} bytes\n`);

        // Generate proper YAML content
        const yamlContent = `version: ${version}
files:
  - url: Sonacove-Meets-Setup.exe
    sha512: ${newSha512}
    size: ${newSize}
path: Sonacove-Meets-Setup.exe
sha512: ${newSha512}
releaseDate: '${new Date().toISOString().split('T')[0]}'
`;

        fs.writeFileSync(yamlPath, yamlContent);
        console.log('   ✅ latest.yml regenerated successfully\n');
        
    } catch (error) {
        console.warn(`   ⚠️  Failed to regenerate latest.yml: ${error.message}\n`);
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
            filePath
        ];

        const signProcess = spawn(signToolPath, args, {
            stdio: 'inherit',
            shell: false,
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

        console.log('   ⏳ Sign tool not found, installing...');
        installSignTool().then(resolve);
    });
}

exports.default = async function(context) {
    if (process.platform !== 'win32') {
        console.log('⏭️  Skipping (not running on Windows)');
        return;
    }

    console.log('\n═══════════════════════════════════════════════════');
    console.log('   Code Signing & Icon Embedding - Sonacove Meets');
    console.log('═══════════════════════════════════════════════════\n');

    try {
        const credentials = loadAzureCredentials();
        console.log('   ✅ Credentials loaded\n');

        console.log('🔍 Checking .NET SDK...');
        await new Promise((resolve) => {
            const check = spawn('dotnet', ['--version'], { shell: true, stdio: 'pipe' });
            let version = '';
            check.stdout.on('data', (data) => { version += data.toString(); });
            check.on('close', (code) => {
                if (code === 0) {
                    console.log(`   ✅ .NET SDK found (${version.trim()})`);
                } else {
                    console.log('   ⚠️  .NET SDK not found');
                }
                resolve();
            });
            check.on('error', () => {
                console.log('   ⚠️  .NET SDK not found');
                resolve();
            });
        });

        console.log('   Checking sign tool...');
        await ensureSignToolInstalled();

        // ONLY afterPack phase (context.appOutDir exists)
        if (context.appOutDir) {
            const appOutDir = context.appOutDir;
            console.log(`📂 Processing: ${appOutDir}\n`);
            
            const files = fs.readdirSync(appOutDir);
            const exeFiles = files.filter(f => f.endsWith('.exe'));
            
            console.log(`Found ${exeFiles.length} executable(s)\n`);

            console.log('🔐 Signing executables...\n');
            for (const file of exeFiles) {
                const filePath = path.join(appOutDir, file);
                await signFile(filePath, credentials);
            }

            console.log('\n📎 Embedding icon...\n');
            const iconPath = path.join(__dirname, 'resources', 'icon.ico');
            const mainExePath = path.join(appOutDir, 'Sonacove Meets.exe');
            await embedIcon(mainExePath, iconPath);

            // Sign resources
            const resourcesDir = path.join(appOutDir, 'resources');
            if (fs.existsSync(resourcesDir)) {
                const resourceFiles = fs.readdirSync(resourcesDir);
                const resourceExes = resourceFiles.filter(f => f.endsWith('.exe'));

                if (resourceExes.length > 0) {
                    console.log(`\n🔐 Signing resource executables...\n`);
                    for (const file of resourceExes) {
                        const filePath = path.join(resourcesDir, file);
                        await signFile(filePath, credentials);
                    }
                }
            }
        } 
        // afterAllArtifactBuild phase - sign installer and regenerate latest.yml
        else {
            console.log('📂 afterAllArtifactBuild phase\n');

            const distDir = path.join(__dirname, 'dist');

            if (fs.existsSync(distDir)) {
                const files = fs.readdirSync(distDir);
                const exeFiles = files.filter(f => f.endsWith('.exe'));

                if (exeFiles.length > 0) {
                    console.log(`🔐 Signing installer artifacts...\n`);
                    for (const file of exeFiles) {
                        const filePath = path.join(distDir, file);
                        await signFile(filePath, credentials);
                    }
                }
            }

            // REGENERATE latest.yml with correct checksums AFTER signing
            await regenerateLatestYml(distDir);
        }

        console.log('\n═══════════════════════════════════════════════════');
        console.log('      ✅ Completed Successfully');
        console.log('═══════════════════════════════════════════════════\n');

    } catch (error) {
        console.error('\n═══════════════════════════════════════════════════');
        console.error('      ❌ Failed');
        console.error('═══════════════════════════════════════════════════');
        console.error(`Error: ${error.message}\n`);
        throw error;
    }
};
