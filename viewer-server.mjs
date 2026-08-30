import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import {
  getCinemaInfo,
  getBroadcastInfo
} from "./livekit-service.mjs";

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const app = express();

const PORT = 3000;

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

app.get(
  "/api/cinema",
  async (req, res) => {
    try {
      const info =
        await getCinemaInfo();

      res.json({
        success: true,
        ...info
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

app.get(
  "/control",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "control.html"
      )
    );
  }
);

app.get(
  "/api/broadcast",
  async (req, res) => {
    try {
      const info =
        await getBroadcastInfo();

      res.json({
        success: true,
        ...info
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

app.get(
  "*splat",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

app.listen(
  PORT,
  "127.0.0.1",
  () => {
    console.log(
      `Berlin Cinema Viewer`
    );

    console.log(
      `http://localhost:${PORT}`
    );
  }
);