import express, { Express, Router as ExpressRouter } from "express";
import { Router } from "../router";
import type { DockgeServer } from "../dockge-server";

export class ImageRouter extends Router {
    create(app: Express, server: DockgeServer): ExpressRouter {
        const router = express.Router();
        // No body parser: archives are streamed directly to the selected Docker host.
        router.all("/api/image-transfers/:ticket", (req, res) => {
            server.imageTransfers.serve(req.params.ticket, req, res).catch(() => res.destroy());
        });
        return router;
    }
}
