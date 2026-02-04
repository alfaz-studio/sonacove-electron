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
      
      console.log(`Found ${exeFiles.length} executable(s) to sign`);
      
      for (const file of exeFiles) {
        const filePath = path.join(appOutDir, file);
        await signFile(filePath, credentials);
      }

      // Sign resources (e.g. elevate.exe)
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

      for (const filePath of exeArtifacts) {
        await signFile(filePath, credentials);
      }
    }

    console.log('\n═══════════════════════════════════════════════════');
    console.log('      ✅ Signing Completed Successfully');
    console.log('═══════════════════════════════════════════════════\n');

  } catch (error) {
        console.error('\n═══════════════════════════════════════════════════');
        console.error('      ❌ Signing Failed');
        console.error('═══════════════════════════════════════════════════');
        console.error(`Error: ${error.message}\n`);
        throw error;
    }
};
