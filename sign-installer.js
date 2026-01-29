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
            return JSON.parse(fs.readFileSync(credPath, 'utf8'));
        }
    }

    if (process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET
      && process.env.AZURE_TENANT_ID && process.env.AZURE_SUBSCRIPTION_ID) {
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

exports.default = async function(context) {
    if (process.platform !== 'win32') {
        return;
    }

    console.log('\n═══════════════════════════════════════════════════');
    console.log('   Signing Installers');
    console.log('═══════════════════════════════════════════════════\n');

    try {
        const credentials = loadAzureCredentials();

        // Sign files in the dist directory (installer, uninstaller)
        const distDir = context.outDir;

        if (fs.existsSync(distDir)) {
            const distFiles = fs.readdirSync(distDir);
            const installerFiles = distFiles.filter(f =>
                f.endsWith('-Setup.exe')
        || f.includes('uninstaller')
        || (f.endsWith('.exe') && (f.includes('Setup') || f.includes('uninstaller')))
            );

            if (installerFiles.length > 0) {
                console.log(`Found ${installerFiles.length} installer file(s):`);
                for (const file of installerFiles) {
                    const filePath = path.join(distDir, file);

                    if (fs.existsSync(filePath)) {
                        await signFile(filePath, credentials);
                    }
                }
            }
        }

        console.log('\n═══════════════════════════════════════════════════');
        console.log('      ✅ Installer Signing Completed');
        console.log('═══════════════════════════════════════════════════\n');

    } catch (error) {
        console.error(`❌ Installer signing failed: ${error.message}\n`);
        throw error;
    }
};
