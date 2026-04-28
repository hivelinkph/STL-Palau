import os, glob

# Files to update
files = (
    ['c:/AntiGravity/STL_Palau/index.html', 'c:/AntiGravity/STL_Palau/play.html', 'c:/AntiGravity/STL_Palau/admin.html'] +
    glob.glob('c:/AntiGravity/STL_Palau/Assets/js/*.js') + 
    glob.glob('c:/AntiGravity/STL_Palau/Assets/css/*.css') + 
    ['c:/AntiGravity/STL_Palau/STL_Palau_Concept_Paper.html', 'c:/AntiGravity/STL_Palau/STL_Nauru_Concept_Paper.html']
)

for f in files:
    if not os.path.exists(f): continue
    try:
        with open(f, 'r', encoding='utf-8') as file:
            content = file.read()
        
        # Text replacements
        content = content.replace('STL Palau', 'Lucky 21')
        content = content.replace('Palau', 'Nauru')
        content = content.replace('Small Town Lottery', 'Nauru Lottery')
        content = content.replace('🇵🇼', '🇳🇷')
        content = content.replace('stl-palau.vercel.app', 'stl-nauru.vercel.app')
        
        # CSS variable replacements across HTML and CSS
        content = content.replace('--blue:       #45B8E5;', '--blue:       #002B7F;')
        content = content.replace('--blue-dark:  #2A8FBA;', '--blue-dark:  #001C53;')
        content = content.replace('--blue-glow:  rgba(69,184,229,0.35);', '--blue-glow:  rgba(0,43,127,0.35);')
        content = content.replace('--gold:       #FFD600;', '--gold:       #FFC61E;')
        content = content.replace('--gold-dark:  #E0B800;', '--gold-dark:  #DDA514;')
        content = content.replace('--gold-glow:  rgba(255,214,0,0.35);', '--gold-glow:  rgba(255,198,30,0.35);')
        
        with open(f, 'w', encoding='utf-8') as file:
            file.write(content)
        print('Updated', f)
    except Exception as e:
        print('Failed on', f, str(e))

import shutil
old_file = 'c:/AntiGravity/STL_Palau/STL_Palau_Concept_Paper.html'
new_file = 'c:/AntiGravity/STL_Palau/Lucky_21_Concept_Paper.html'
if os.path.exists(old_file):
    shutil.move(old_file, new_file)

print('Done Replacements.')
