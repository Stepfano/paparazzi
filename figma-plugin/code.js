// Runs in the Figma plugin sandbox. The UI does all networking (the sandbox has no fetch)
// and hands over raw bytes; this turns them into canvas nodes.

const TARGET_W = 280;
const GAP = 28;
const PER_ROW = 10;

figma.showUI(__html__, { width: 420, height: 720 });

// Each person's hub can run on a different port; remember whichever one this user actually
// configured instead of resetting to the baked-in default every time the plugin reopens.
figma.clientStorage.getAsync('hubHost').then((savedHost) => {
  figma.ui.postMessage({ type: 'init', savedHost: savedHost || null });
});

const anchor = { x: Math.round(figma.viewport.center.x), y: Math.round(figma.viewport.center.y) };
let col = 0, rowTopY = 0, curRowMaxH = 0;

// One journey should land as a labelled row, so a reviewer reads it left to right.
function newGroupRow() {
  if (col !== 0) {
    col = 0;
    rowTopY += curRowMaxH + GAP;
    curRowMaxH = 0;
  }
}

async function place(msg) {
  const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(Object.values(msg.bytes));
  const image = figma.createImage(bytes);
  const { width, height } = await image.getSizeAsync();

  const w = TARGET_W;
  const h = Math.round(height * (TARGET_W / width));

  if (col >= PER_ROW) { col = 0; rowTopY += curRowMaxH + GAP; curRowMaxH = 0; }

  const rect = figma.createRectangle();
  // The layer name stays a useful identifier in the Layers panel; nothing is written onto the
  // canvas as visible content — no caption, no text node.
  rect.name = msg.name || msg.id;
  rect.resize(w, h);
  rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];
  rect.cornerRadius = 6;
  rect.x = anchor.x + col * (TARGET_W + GAP);
  rect.y = anchor.y + rowTopY;
  figma.currentPage.appendChild(rect);

  curRowMaxH = Math.max(curRowMaxH, h);
  col++;
  return [rect];
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'save-host') {
    await figma.clientStorage.setAsync('hubHost', msg.host);
    return;
  }

  if (msg.type === 'insert') {
    const made = [];
    if (msg.newRow) newGroupRow();
    for (const item of msg.items) {
      try {
        const nodes = await place(item);
        made.push(...nodes);
        figma.ui.postMessage({ type: 'placed', id: item.id });
      } catch (e) {
        figma.ui.postMessage({ type: 'error', message: `${item.id}: ${e.message}` });
      }
    }
    if (made.length) {
      figma.currentPage.selection = made;
      figma.viewport.scrollAndZoomIntoView(made);
      figma.notify(`Inserted ${msg.items.length} screenshot${msg.items.length === 1 ? '' : 's'}`);
    }
    figma.ui.postMessage({ type: 'insert-done' });
    return;
  }
  if (msg.type === 'notify') figma.notify(msg.message);
  if (msg.type === 'close') figma.closePlugin();
};
