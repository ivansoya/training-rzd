import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import BoxCanvas from "../src/components/mag/BoxCanvas";
import "../src/styles/tokens.css";
import "../src/styles/editor.css";

function Fixture() {
  const [frame, setFrame] = useState<{ id: string; src?: string; bitmap?: ImageBitmap; waiting?: boolean }>({
    id: "first", src: "/canvas-images/first.png",
  });
  const api = window as any;
  api.edits ??= 0;
  api.canvasFixture = {
    image: (id: string, src: string) => setFrame({ id, src }),
    bitmap: async (id: string, waiting = false, closed = false) => {
      const c = document.createElement("canvas"); c.width = 320; c.height = 240;
      c.getContext("2d")!.fillRect(0, 0, 320, 240);
      const bitmap = await createImageBitmap(c);
      if (closed) bitmap.close();
      setFrame({ id, bitmap, waiting });
    },
    finishWaiting: () => setFrame((f) => ({ ...f, waiting: false })),
  };
  return <div style={{ display: "flex", height: 500 }}>
    <BoxCanvas imageId={frame.id} src={frame.src} bitmap={frame.bitmap} waiting={frame.waiting}
      width={320} height={240} editable tool="box" activeClass={0} selected={0}
      boxes={[{ id: frame.id, class_index: 0, x: 20, y: 20, w: 80, h: 60 }]}
      labelOf={() => ({ name: "Объект", color: "#0090ff" })}
      ghosts={[{ x: 150, y: 30, w: 60, h: 50, name: "Находка", color: "#ffc53d", conf: .8, class_index: 0 }]}
      onBoxes={() => { api.edits += 1; }} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
