const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Azure Trusted Signing Configuration
const AZURE_CONFIG = {
  endpoint: 'https://eus.codesigning.azure.net/',
  accountName: 'sonacovemeets',
  certificateProfileName: 'SonacoveMeetsDesktopApp'
};

// Timestamp server (Microsoft's recommended)
const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

// Load Azure credentials
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

  if (process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET && 
      process.env.AZURE_TENANT_ID && process.env.AZURE_SUBSCRIPTION_ID) {
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

async function signWithDotNetTool(filePath, credentials) {
  return new Promise((resolve, reject) => {
  const args = [
  'code', 'trusted-signing',
  '-tse', AZURE_CONFIG.endpoint,
  '-tsa', AZURE_CONFIG.accountName,
  '-tscp', AZURE_CONFIG.certificateProfileName,
  '-fd', 'SHA256',
  '-t', TIMESTAMP_URL,
  '-v', 'debug',
  filePath
  ];

    console.log(`   Executing: sign code trusted-signing -tse ${AZURE_CONFIG.endpoint} -tsa ${AZURE_CONFIG.accountName} -tscp ${AZURE_CONFIG.certificateProfileName} "${path.basename(filePath)}"`);

    const signProcess = spawn('sign', args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        AZURE_TENANT_ID: credentials.tenantId,
        AZURE_CLIENT_ID: credentials.clientId,
        AZURE_CLIENT_SECRET: credentials.clientSecret
      }
    });

    signProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Sign tool exited with code ${code}`));
      }
    });

    signProcess.on('error', (error) => {
      reject(error);
    });
  });
}

async function signFile(filePath, credentials) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  console.log(`\n🔐 Signing: ${path.basename(filePath)}`);
  console.log(`   Path: ${filePath}`);

  try {
    await signWithDotNetTool(filePath, credentials);
    console.log(`   ✅ Successfully signed!\n`);
  } catch (error) {
    throw new Error(`Failed to sign: ${error.message}`);
  }
}

async function installSignTool() {
  return new Promise((resolve, reject) => {
    console.log('   📦 Installing Microsoft sign tool...');
    
    const install = spawn('dotnet', ['tool', 'install', '--global', 'sign', '--prerelease'], {
      stdio: 'inherit',
      shell: true
    });

    install.on('close', (code) => {
      if (code === 0) {
        console.log('   ✅ Sign tool installed\n');
        resolve();
      } else {
        const update = spawn('dotnet', ['tool', 'update', '--global', 'sign', '--prerelease'], {
          stdio: 'inherit',
          shell: true
        });
        
        update.on('close', (updateCode) => {
          if (updateCode === 0) {
            console.log('   ✅ Sign tool updated\n');
            resolve();
          } else {
            reject(new Error('Failed to install/update sign tool'));
          }
        });
      }
    });

    install.on('error', () => {
      reject(new Error('.NET SDK not found. Install from: https://dotnet.microsoft.com/download'));
    });
  });
}

// Main signing function
exports.default = async function(context) {
  if (process.platform !== 'win32') {
    console.log('⏭️  Skipping code signing (not running on Windows)');
    return;
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('   Azure Trusted Signing - Sonacove Meets');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Account: ${AZURE_CONFIG.accountName}`);
  console.log(`Profile: ${AZURE_CONFIG.certificateProfileName}`);
  console.log(`Endpoint: ${AZURE_CONFIG.endpoint}`);
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

    const appOutDir = context.appOutDir;
    console.log(`📂 Scanning for executables in: ${appOutDir}\n`);
    
    const files = fs.readdirSync(appOutDir);
    const exeFiles = files.filter(f => f.endsWith('.exe'));
    
    console.log(`Found ${exeFiles.length} executable(s) to sign`);
    
    for (const file of exeFiles) {
      const filePath = path.join(appOutDir, file);
      await signFile(filePath, credentials);
    }

    console.log('═══════════════════════════════════════════════════');
    console.log('      ✅ Signing Completed Successfully');
    console.log('═══════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n═══════════════════════════════════════════════════');
    console.error('      ❌ Signing Failed');
    console.error('═══════════════════════════════════════════════════');
    console.error(`Error: ${error.message}\n`);
    
    console.error('Setup Instructions:');
    console.error('1. Install .NET SDK 8.0+: https://dotnet.microsoft.com/download');
    console.error('2. Install sign tool: dotnet tool install --global sign --prerelease');
    console.error('3. Verify service principal has "Trusted Signing Certificate Profile Signer" role');
    console.error('4. Check certificate profile is active in Azure Portal\n');
    
    throw error;
  }
};
