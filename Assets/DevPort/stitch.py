import os
from PIL import Image

folder = r"C:\AntiGravity\STL_Palau\Assets\DevPort"
output_pdf = os.path.join(folder, "compiled_portfolio.pdf")

files = [f for f in os.listdir(folder) if f.lower().endswith('.jpeg') or f.lower().endswith('.jpg')]

# Sort by the numeric part
files.sort(key=lambda x: int(os.path.splitext(x)[0]))

images = []
for f in files:
    img_path = os.path.join(folder, f)
    image = Image.open(img_path).convert('RGB')
    images.append(image)

if images:
    images[0].save(output_pdf, save_all=True, append_images=images[1:])
    print(f"Successfully saved to {output_pdf}")
else:
    print("No JPEG files found.")
