# Icons

To use this extension, you need to create PNG icons from the SVG file:

1. Open `icon.svg` in an image editor (like GIMP, Photoshop, or online tool like https://cloudconvert.com/svg-to-png)
2. Export to PNG at the following sizes:
   - icon16.png (16x16 pixels)
   - icon48.png (48x48 pixels)
   - icon128.png (128x128 pixels)

Alternatively, you can use ImageMagick from the command line:
```bash
convert -background none icon.svg -resize 16x16 icon16.png
convert -background none icon.svg -resize 48x48 icon48.png
convert -background none icon.svg -resize 128x128 icon128.png
```

Or use an online SVG to PNG converter and download the files at the required sizes.
