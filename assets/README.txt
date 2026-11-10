OFFICE PIXEL ART - FREE v1.0
Top-down 3/4 office tileset, 32x32, by Imersa Studios
https://imersastudios.itch.io/office-pixel-art

WHAT IS INSIDE
- 16 props (64 sprites: front, back, left and right where they differ), in 8 categories
- 3 seamless floor tiles
- 25 wall tiles in 1 modular wall tileset(s) with a template room each (Tiled .tmj)
- 1 ready-made room(s) as Tiled maps: Meeting Room
- 1 hand-drawn animated character(s), 32x32: idle + walk, 4 directions, 4 frames each (32 frames)

FOLDERS
- Props/<Category>/<prop>/   <prop>_front|back|left|right.png + <prop>.json (anchor, footprint)
- Props/_Atlases/            one sprite sheet per category + JSON (frame rects and anchors)
- Tilesets/Floors/           floor tiles (.png + Tiled .tsj) and a preview
- Tilesets/Walls_*/          wall tiles (.png + .tsj), a template room (.tmj + preview) showing where each tile goes
- Rooms/<Room>/              <room>.tmj (Tiled), <room>.json (engine-neutral), tileset, props atlas, single props, preview
- Characters/<name>/         <name>.png (4x8 sheet), _idle.png, _walk.png, .json, Godot 4 SpriteFrames (.tres), preview GIF

HOW IT FITS TOGETHER
- Grid: 32x32 px tiles, 1 tile = 1 metre. View: top-down 3/4 (camera at 60 degrees). No upscaling needed.
- Walls are 2 tiles tall (64 px) plus a 16 px top. Back walls show their face; side and front walls show only their top.
- Props: draw them sorted by their anchor's y (y-sort). The anchor (in the .json) is the point on the floor under the
  object: put that pixel on the map position. "footprint" is the floor area in tiles, for collisions.
- Characters: frames are 32x32, feet on pixel (16, 30). Rows: idle down/left/right/up, then walk down/left/right/up.
  4 frames per row: idle at 4 fps, walk at 8 fps. Sort them with the props by their feet.
- Rooms: open the .tmj in Tiled. Layers: floor, walls, then an object layer with every prop in drawing order.
  The .json next to it has the same map for engines without a Tiled importer.

ENGINES
- Godot 4: drop a character folder in, use the .tres as the SpriteFrames of an AnimatedSprite2D (y-sort on).
  Rooms import with the "Tiled Map Importer" add-on, or build them from the .json.
- Unity: import PNGs with Filter Mode = Point, Compression = None, Pixels Per Unit = 32; set each sprite's
  pivot from its anchor. Rooms load with SuperTiled2Unity.
- GameMaker / Construct / Defold / RPG Maker: every sprite is a plain PNG; sheets have fixed cells.

WANT MORE?
The Pro and Premium versions add more props, rooms and characters: https://imersastudios.itch.io/office-pixel-art

LICENSE
YOU CAN
- Use these assets in personal and commercial projects (games, apps, videos, prototypes, game jams).
- Edit, recolour and combine them with other assets.
- Credit is REQUIRED: "Office Pixel Art by Imersa Studios" in your credits, with a link to https://imersastudios.itch.io/office-pixel-art if you can.

YOU CAN'T
- Resell, share or redistribute the assets themselves, edited or not, alone or in an asset pack,
  template or tileset (they can only ship inside your project).
- Use them to train AI models or in NFT projects.
- Claim them as your own work.

Copyright (c) 2026 Imersa Studios. All rights not granted above are reserved.

Thank you for supporting Imersa Studios!
