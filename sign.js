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
                if (typeof rcedit[key] === 'function') {
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
        }
        
        if (success) {
            console.log(`   ✅ Icon embedded: ${path.basename(exePath)}`);
        } else {
            console.warn(`   ⚠️  Could not determine how to call rcedit - skipping icon embedding`);
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

async function checkAndInstallDotNetTools() {
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
            console.log('   Checking sign tool...');

            const signCheck = spawn('sign', [ '--version' ], { shell: true,
                stdio: 'pipe' });
            let signFound = false;

            signCheck.stdout.on('data', () => {
                signFound = true;
            });

            signCheck.stderr.on('data', () => {
                signFound = true;
            });

            signCheck.on('close', signCode => {
                if (signFound || signCode === 0) {
                    console.log('   ✅ Sign tool found\n');
                    resolve();
                } else {
                    installSignTool().then(resolve)
.catch(reject);
                }
            });

            signCheck.on('error', () => {
                installSignTool().then(resolve)
.catch(reject);
            });
        });

        check.on('error', error => {
            reject(error);
        });
    });
}

exports.default = async function(context) {
    if (process.platform !== 'win32') {
        console.log('⏭️  Skipping code signing (not running on Windows)');

        return;
    }

    console.log('\n═══════════════════════════════════════════════════');
    console.log('   Azure Trusted Signing - Sonacove Meets');
    console.log('═══════════════════════════════════════════════════\n');

    try {
        console.log('📋 Loading Azure credentials...');
        const credentials = loadAzureCredentials();

        console.log('   ✅ Credentials loaded\n');

    console.log('🔍 Checking .NET SDK...');
    await new Promise((resolve, reject) => {
      const check = spawn('dotnet', ['--version'], { shell: true, stdio: 'pipe' });
      let version = '';
      check.stdout.on('data', (data) => { version += data.toString(); });
      check.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('.NET SDK not found. Install from: https://dotnet.microsoft.com/download'));
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
          // Try to install
          installSignTool().then(resolve).catch(reject);
        }
      });
      check.on('error', () => {
        // Try to install
        installSignTool().then(resolve).catch(reject);
      });
    });

    // HANDLE AFTER_SIGN (Unpacked executables)
    if (context.appOutDir) {
      const appOutDir = context.appOutDir;
      console.log(`📂 Scanning for unpacked executables in: ${appOutDir}\n`);
      
      const files = fs.readdirSync(appOutDir);
      const exeFiles = files.filter(f => f.endsWith('.exe'));
      
      console.log(`Found ${exeFiles.length} executable(s)`);

      // EMBED ICON ONLY (do NOT sign here)
      // Signing changes the file, breaking checksums
      // We'll sign in afterAllArtifactBuild instead
      console.log('\n📎 Embedding icon into executables...');
      const iconPath = path.join(__dirname, 'resources', 'icon.ico');
      const mainExePath = path.join(appOutDir, 'Sonacove Meets.exe');
      await embedIcon(mainExePath, iconPath);
      
      console.log('\n⏭️  Skipping signing in afterPack phase (will sign in afterAllArtifactBuild)');
    } 
    // HANDLE AFTER_ALL_ARTIFACT_BUILD or ON_BEFORE_PUBLISH (Installer)
    else {
      let exeArtifacts = [];
      
      // Log the context for debugging
      console.log(`📋 Context object keys: ${Object.keys(context)}`);
      if (context.artifactPaths) {
        console.log(`📋 Artifact paths from context: ${context.artifactPaths}`);
      }
      
      // Check if we have artifactPaths (from afterAllArtifactBuild)
      if (context.artifactPaths) {
        console.log(`📂 Scanning for artifacts to sign from context...\n`);
        exeArtifacts = context.artifactPaths.filter(f => f.endsWith('.exe'));
      } 
      // Always scan the dist directory as fallback
      const distDir = path.join(__dirname, 'dist');
      if (fs.existsSync(distDir)) {
        console.log(`📂 Scanning for artifacts in dist directory...\n`);
        const files = fs.readdirSync(distDir);
        const distExeArtifacts = files
          .filter(f => f.endsWith('.exe'))
          .map(f => path.join(distDir, f));
        
        // Merge artifacts from both sources (context and dist directory)
        exeArtifacts = [...new Set([...exeArtifacts, ...distExeArtifacts])];
      }
      
      console.log(`Found ${exeArtifacts.length} artifact(s) to sign: ${exeArtifacts}`);

      // SIGN ALL ARTIFACTS (after checksums are locked in latest.yml)
      console.log('\n🔐 Signing all artifacts...');
      for (const filePath of exeArtifacts) {
        await signFile(filePath, credentials);
      }
      
      // Also sign resources if they exist
      const resourcesDir = path.join(__dirname, 'dist', 'win-unpacked', 'resources');
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
        console.error('      ❌ Signing Failed');
        console.error('═══════════════════════════════════════════════════');
        console.error(`Error: ${error.message}\n`);
        throw error;
    }
};
