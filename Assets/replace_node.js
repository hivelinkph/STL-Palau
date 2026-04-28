const fs = require('fs');
const path = require('path');

const doReplacements = () => {
    // Collect all files to replace
    const htmlFiles = ['c:/AntiGravity/STL_Palau/index.html', 'c:/AntiGravity/STL_Palau/play.html', 'c:/AntiGravity/STL_Palau/admin.html', 'c:/AntiGravity/STL_Palau/STL_Palau_Concept_Paper.html'];

    // Quick custom naive glob if glob is not available
    const assetJs = fs.existsSync('c:/AntiGravity/STL_Palau/Assets/js') ? fs.readdirSync('c:/AntiGravity/STL_Palau/Assets/js').filter(f => f.endsWith('.js')).map(f => path.join('c:/AntiGravity/STL_Palau/Assets/js', f)) : [];
    const assetCss = fs.existsSync('c:/AntiGravity/STL_Palau/Assets/css') ? fs.readdirSync('c:/AntiGravity/STL_Palau/Assets/css').filter(f => f.endsWith('.css')).map(f => path.join('c:/AntiGravity/STL_Palau/Assets/css', f)) : [];

    const files = [...htmlFiles, ...assetJs, ...assetCss];

    files.forEach(f => {
        if (!fs.existsSync(f)) return;
        try {
            let content = fs.readFileSync(f, 'utf8');
            content = content.replace(/STL Palau/g, 'Lucky 21');
            content = content.replace(/Palau/g, 'Nauru');
            content = content.replace(/Small Town Lottery/g, 'Nauru Lottery');
            content = content.replace(/🇵🇼/g, '🇳🇷');

            content = content.replace(/--blue:\s*#45B8E5;/g, '--blue:       #002B7F;');
            content = content.replace(/--blue-dark:\s*#2A8FBA;/g, '--blue-dark:  #001C53;');
            content = content.replace(/--blue-glow:\s*rgba\(69,184,229,0\.35\);/g, '--blue-glow:  rgba(0,43,127,0.35);');
            content = content.replace(/--gold:\s*#FFD600;/g, '--gold:       #FFC61E;');
            content = content.replace(/--gold-dark:\s*#E0B800;/g, '--gold-dark:  #DDA514;');
            content = content.replace(/--gold-glow:\s*rgba\(255,214,0,0\.35\);/g, '--gold-glow:  rgba(255,198,30,0.35);');

            // Handle the flag character explicitly as some editors might encode it differently
            content = content.replace(/&#127477;&#127484;/g, '&#127475;&#127479;');

            fs.writeFileSync(f, content, 'utf8');
            console.log('Updated', f);
        } catch (e) {
            console.log('Failed on', f, e.message);
        }
    });

    const oldFile = 'c:/AntiGravity/STL_Palau/STL_Palau_Concept_Paper.html';
    const newFile = 'c:/AntiGravity/STL_Palau/Lucky_21_Concept_Paper.html';
    if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
        fs.renameSync(oldFile, newFile);
    }
};

doReplacements();
