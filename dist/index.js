#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { STLManipulator } from "./stl/stl-manipulator.js";
import { parse3MF } from './3mf_parser.js';
import { BambuImplementation } from "./printers/bambu.js";
dotenv.config();
const DEFAULT_HOST = process.env.PRINTER_HOST || "localhost";
const DEFAULT_BAMBU_SERIAL = process.env.BAMBU_SERIAL || "";
const DEFAULT_BAMBU_TOKEN = process.env.BAMBU_TOKEN || "";
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), "temp");
// Printer model and bed type
const DEFAULT_BAMBU_MODEL = process.env.BAMBU_MODEL?.trim().toLowerCase() || "";
const DEFAULT_BED_TYPE = process.env.BED_TYPE?.trim().toLowerCase() || "textured_plate";
const DEFAULT_NOZZLE_DIAMETER = process.env.NOZZLE_DIAMETER?.trim() || "0.4";
const VALID_BAMBU_MODELS = ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"];
const VALID_BED_TYPES = ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"];
// Map model IDs to BambuStudio --load-machine preset names
const BAMBU_MODEL_PRESETS = {
    p1s: (n) => `Bambu Lab P1S ${n} nozzle`,
    p1p: (n) => `Bambu Lab P1P ${n} nozzle`,
    x1c: (n) => `Bambu Lab X1 Carbon ${n} nozzle`,
    x1e: (n) => `Bambu Lab X1E ${n} nozzle`,
    a1: (n) => `Bambu Lab A1 ${n} nozzle`,
    a1mini: (n) => `Bambu Lab A1 mini ${n} nozzle`,
    h2d: (n) => `Bambu Lab H2D ${n} nozzle`,
};
function validateBambuModel(model) {
    const normalized = model.trim().toLowerCase();
    if (!VALID_BAMBU_MODELS.includes(normalized)) {
        throw new Error(`Invalid bambu_model: "${model}". Valid models: ${VALID_BAMBU_MODELS.join(", ")}`);
    }
    return normalized;
}
function resolveBedType(argsBedType) {
    const bedType = (argsBedType || DEFAULT_BED_TYPE).trim().toLowerCase();
    if (!VALID_BED_TYPES.includes(bedType)) {
        throw new Error(`Invalid bed_type: "${bedType}". Valid types: ${VALID_BED_TYPES.join(", ")}`);
    }
    return bedType;
}
// Slicer configuration (defaults to bambustudio)
const DEFAULT_SLICER_TYPE = process.env.SLICER_TYPE || "bambustudio";
const DEFAULT_SLICER_PATH = process.env.SLICER_PATH || "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio";
const DEFAULT_SLICER_PROFILE = process.env.SLICER_PROFILE || "";
function parseBooleanEnv(rawValue, fallback) {
    if (rawValue === undefined)
        return fallback;
    const value = rawValue.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(value))
        return true;
    if (["0", "false", "no", "off"].includes(value))
        return false;
    return fallback;
}
function parsePort(value, fallback) {
    if (!value)
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`Invalid MCP_HTTP_PORT value: ${value}`);
    }
    return parsed;
}
function normalizePath(pathValue) {
    const value = (pathValue ?? "/mcp").trim();
    if (!value)
        return "/mcp";
    return value.startsWith("/") ? value : `/${value}`;
}
function parseCsvEnv(value) {
    if (!value)
        return new Set();
    return new Set(value.split(",").map((e) => e.trim()).filter((e) => e.length > 0));
}
function readRuntimeConfig() {
    const rawTransport = process.env.MCP_TRANSPORT?.trim().toLowerCase();
    const transport = rawTransport === "streamable-http" || rawTransport === "http"
        ? "streamable-http"
        : "stdio";
    return {
        transport,
        httpHost: process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1",
        httpPort: parsePort(process.env.MCP_HTTP_PORT, 3000),
        httpPath: normalizePath(process.env.MCP_HTTP_PATH),
        statefulSession: parseBooleanEnv(process.env.MCP_HTTP_STATEFUL, true),
        enableJsonResponse: parseBooleanEnv(process.env.MCP_HTTP_JSON_RESPONSE, true),
        allowedOrigins: parseCsvEnv(process.env.MCP_HTTP_ALLOWED_ORIGINS),
        blenderBridgeCommand: process.env.BLENDER_MCP_BRIDGE_COMMAND?.trim() || undefined,
    };
}
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}
class BambuPrinterMCPServer {
    constructor() {
        this.runtimeConfig = readRuntimeConfig();
        this.server = new Server({
            name: "bambu-printer-mcp",
            version: "1.0.0"
        }, {
            capabilities: {
                resources: {},
                tools: {}
            }
        });
        this.bambu = new BambuImplementation();
        this.stlManipulator = new STLManipulator(TEMP_DIR);
        this.setupHandlers();
        this.setupErrorHandling();
    }
    setupErrorHandling() {
        this.server.onerror = (error) => {
            console.error("[MCP Error]", error);
        };
    }
    setupHandlers() {
        this.setupResourceHandlers();
        this.setupToolHandlers();
    }
    /**
     * Resolve the Bambu printer model from args, env, or by asking the user via elicitation.
     * This is critical for safety: the wrong model can cause physical damage to the printer.
     */
    async resolveBambuModel(argsModel) {
        const fromArgs = (argsModel || DEFAULT_BAMBU_MODEL).trim().toLowerCase();
        if (fromArgs) {
            return validateBambuModel(fromArgs);
        }
        // No model from args or env — ask the user via elicitation
        try {
            const result = await this.server.elicitInput({
                mode: "form",
                message: "Your Bambu Lab printer model is required for safe operation. " +
                    "Using the wrong model can cause the bed to crash into the nozzle and damage the printer.",
                requestedSchema: {
                    type: "object",
                    properties: {
                        bambu_model: {
                            type: "string",
                            title: "Printer Model",
                            description: "Which Bambu Lab printer do you have?",
                            oneOf: [
                                { const: "p1s", title: "P1S" },
                                { const: "p1p", title: "P1P" },
                                { const: "x1c", title: "X1 Carbon" },
                                { const: "x1e", title: "X1E" },
                                { const: "a1", title: "A1" },
                                { const: "a1mini", title: "A1 Mini" },
                                { const: "h2d", title: "H2D" },
                            ],
                        },
                    },
                    required: ["bambu_model"],
                },
            });
            if (result.action === "accept" && result.content?.bambu_model) {
                return validateBambuModel(String(result.content.bambu_model));
            }
            throw new Error("Printer model selection was cancelled. Cannot proceed without knowing the printer model.");
        }
        catch (elicitError) {
            // Elicitation not supported by this client — fall back to a clear error
            const msg = elicitError?.message || String(elicitError);
            if (elicitError?.code === -32601 || elicitError?.code === -32600 ||
                msg.includes("does not support") || msg.includes("elicitation")) {
                throw new Error("bambu_model is required but your MCP client does not support elicitation. " +
                    `Set the BAMBU_MODEL environment variable or pass bambu_model in the tool call. ` +
                    `Valid models: ${VALID_BAMBU_MODELS.join(", ")}`);
            }
            throw elicitError;
        }
    }
    setupResourceHandlers() {
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return {
                resources: [
                    {
                        uri: `printer://${DEFAULT_HOST}/status`,
                        name: "Bambu Printer Status",
                        mimeType: "application/json",
                        description: "Current status of the Bambu Lab printer"
                    },
                    {
                        uri: `printer://${DEFAULT_HOST}/files`,
                        name: "Bambu Printer Files",
                        mimeType: "application/json",
                        description: "List of files on the Bambu Lab printer"
                    }
                ],
                templates: [
                    {
                        uriTemplate: "printer://{host}/status",
                        name: "Bambu Printer Status",
                        mimeType: "application/json"
                    },
                    {
                        uriTemplate: "printer://{host}/files",
                        name: "Bambu Printer Files",
                        mimeType: "application/json"
                    }
                ]
            };
        });
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;
            const match = uri.match(/^printer:\/\/([^\/]+)\/(.+)$/);
            if (!match) {
                throw new McpError(ErrorCode.InvalidRequest, `Invalid resource URI: ${uri}`);
            }
            const [, host, resource] = match;
            const bambuSerial = DEFAULT_BAMBU_SERIAL;
            const bambuToken = DEFAULT_BAMBU_TOKEN;
            let content;
            if (resource === "status") {
                content = await this.bambu.getStatus(host || DEFAULT_HOST, bambuSerial, bambuToken);
            }
            else if (resource === "files") {
                content = await this.bambu.getFiles(host || DEFAULT_HOST, bambuSerial, bambuToken);
            }
            else {
                throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${resource}`);
            }
            return {
                contents: [
                    {
                        uri,
                        mimeType: "application/json",
                        text: JSON.stringify(content, null, 2)
                    }
                ]
            };
        });
    }
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "get_printer_status",
                        description: "Get the current status of the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: {
                                    type: "string",
                                    description: "Hostname or IP address of the printer (default: value from env)"
                                },
                                bambu_serial: {
                                    type: "string",
                                    description: "Serial number for the Bambu Lab printer (default: value from env)"
                                },
                                bambu_token: {
                                    type: "string",
                                    description: "Access token for the Bambu Lab printer (default: value from env)"
                                }
                            }
                        }
                    },
                    {
                        name: "extend_stl_base",
                        description: "Extend the base of an STL file by a specified amount",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file to modify" },
                                extension_height: { type: "number", description: "Height in mm to extend the base by" }
                            },
                            required: ["stl_path", "extension_height"]
                        }
                    },
                    {
                        name: "scale_stl",
                        description: "Scale an STL file by specified factors",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file to scale" },
                                scale_x: { type: "number", description: "Scale factor for X axis (default: 1.0)" },
                                scale_y: { type: "number", description: "Scale factor for Y axis (default: 1.0)" },
                                scale_z: { type: "number", description: "Scale factor for Z axis (default: 1.0)" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "rotate_stl",
                        description: "Rotate an STL file by specified angles (degrees)",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file to rotate" },
                                angle_x: { type: "number", description: "Rotation angle for X axis in degrees (default: 0)" },
                                angle_y: { type: "number", description: "Rotation angle for Y axis in degrees (default: 0)" },
                                angle_z: { type: "number", description: "Rotation angle for Z axis in degrees (default: 0)" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "get_stl_info",
                        description: "Get detailed information about an STL file (bounding box, face count, dimensions)",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file to analyze" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "slice_stl",
                        description: "Slice an STL or 3MF file using a slicer to generate printable G-code or sliced 3MF. IMPORTANT: bambu_model must be specified to ensure the slicer generates safe G-code for the correct printer.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL or 3MF file to slice" },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                                    description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                                },
                                slicer_type: {
                                    type: "string",
                                    description: "Type of slicer to use (bambustudio, prusaslicer, cura, slic3r, orcaslicer) (default: bambustudio)"
                                },
                                slicer_path: { type: "string", description: "Path to the slicer executable (default: value from env)" },
                                slicer_profile: { type: "string", description: "Path to the slicer profile/config file (optional, overrides bambu_model preset)" },
                                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm (default: 0.4)" },
                                uptodate: { type: "boolean", description: "Refresh 3MF preset configs to match the latest BambuStudio version. Use when slicing downloaded or older 3MF files to prevent stale-config failures." },
                                repetitions: { type: "number", description: "Print N identical copies of the model. Each copy gets its own plate placement. Example: 3 prints three copies." },
                                orient: { type: "boolean", description: "Auto-orient the model for optimal printability (minimize supports, maximize bed adhesion). Recommended for raw STL imports that lack a pre-set orientation." },
                                arrange: { type: "boolean", description: "Auto-arrange all objects on the build plate with optimal spacing. Recommended when importing STLs or adding multiple objects. Set false to preserve existing plate layout." },
                                ensure_on_bed: { type: "boolean", description: "Detect models floating above the bed and lower them onto the build surface. Safety net for imported models with incorrect Z origins." },
                                clone_objects: { type: "string", description: "Duplicate specific objects on the plate. Comma-separated clone counts per object index, e.g. '1,3,1,10' clones object 0 once, object 1 three times, etc." },
                                skip_objects: { type: "string", description: "Skip specific objects during slicing by index. Comma-separated, e.g. '3,5,10'. Useful for multi-object 3MFs where you only want to print some parts." },
                                load_filaments: { type: "string", description: "Override filament profiles. Semicolon-separated paths to filament JSON configs, e.g. 'pla_basic.json;petg_cf.json'." },
                                load_filament_ids: { type: "string", description: "Map filaments to objects/parts. Comma-separated IDs matching load_filaments order, e.g. '1,2,3,1' assigns filament 1 to objects 0 and 3." },
                                enable_timelapse: { type: "boolean", description: "Insert timelapse parking moves into gcode. The toolhead parks at a fixed position each layer for camera capture. Adds ~10% print time." },
                                allow_mix_temp: { type: "boolean", description: "Allow filaments with different temperature requirements on the same plate. Required for multi-material prints mixing e.g. PLA and PETG." },
                                scale: { type: "number", description: "Uniform scale factor applied to all axes. 1.0 = original size, 2.0 = double, 0.5 = half. Applied before slicing." },
                                rotate: { type: "number", description: "Rotate the model around the Z-axis (vertical) by this many degrees before slicing. Positive = counterclockwise when viewed from above." },
                                rotate_x: { type: "number", description: "Rotate the model around the X-axis by this many degrees before slicing. Useful for reorienting prints for better layer adhesion." },
                                rotate_y: { type: "number", description: "Rotate the model around the Y-axis by this many degrees before slicing. Useful for reorienting prints for better layer adhesion." },
                                min_save: { type: "boolean", description: "Write a smaller output 3MF by omitting non-essential metadata. Reduces file size for faster FTP upload to the printer." },
                                skip_modified_gcodes: { type: "boolean", description: "Strip custom start/end gcodes embedded in the 3MF. Recommended for downloaded 3MFs since custom gcodes from other users' profiles may be unsafe for your printer." },
                                slice_plate: { type: "number", description: "Which plate index to slice. 0 = all plates (default). Use 1, 2, etc. to slice only a specific plate in multi-plate 3MF projects." }
                            },
                            required: ["stl_path", "bambu_model"]
                        }
                    },
                    {
                        name: "list_printer_files",
                        description: "List files stored on the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            }
                        }
                    },
                    {
                        name: "upload_gcode",
                        description: "Upload a G-code file to the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filename: { type: "string", description: "Name for the file on the printer" },
                                gcode: { type: "string", description: "G-code content to upload" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["filename", "gcode"]
                        }
                    },
                    {
                        name: "upload_file",
                        description: "Upload a local file to the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                file_path: { type: "string", description: "Local path to the file to upload" },
                                filename: { type: "string", description: "Name for the file on the printer" },
                                print: { type: "boolean", description: "Start printing after upload (default: false)" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["file_path", "filename"]
                        }
                    },
                    {
                        name: "start_print_job",
                        description: "Start printing a G-code file already on the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filename: { type: "string", description: "Name of the file to print" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["filename"]
                        }
                    },
                    {
                        name: "cancel_print",
                        description: "Cancel the current print job on the Bambu Lab printer",
                        inputSchema: {
                            type: "object",
                            properties: {
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            }
                        }
                    },
                    {
                        name: "set_temperature",
                        description: "Set the temperature of a printer component (bed, nozzle)",
                        inputSchema: {
                            type: "object",
                            properties: {
                                component: { type: "string", description: "Component to heat: bed, nozzle, or extruder" },
                                temperature: { type: "number", description: "Target temperature in °C" },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" }
                            },
                            required: ["component", "temperature"]
                        }
                    },
                    {
                        name: "print_3mf",
                        description: "Print a 3MF file on a Bambu Lab printer. Auto-slices if the 3MF has no gcode. IMPORTANT: bambu_model must be specified to ensure safe printer operation.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                three_mf_path: { type: "string", description: "Path to the 3MF file to print" },
                                bambu_model: {
                                    type: "string",
                                    enum: ["p1s", "p1p", "x1c", "x1e", "a1", "a1mini", "h2d"],
                                    description: "REQUIRED: Bambu Lab printer model. Ask the user if not known. Using the wrong model can damage the printer."
                                },
                                bed_type: {
                                    type: "string",
                                    enum: ["textured_plate", "cool_plate", "engineering_plate", "hot_plate"],
                                    description: "Bed plate type currently installed (default: textured_plate)"
                                },
                                host: { type: "string", description: "Hostname or IP of the printer (default: value from env)" },
                                bambu_serial: { type: "string", description: "Serial number (default: value from env)" },
                                bambu_token: { type: "string", description: "Access token (default: value from env)" },
                                use_ams: { type: "boolean", description: "Whether to use the AMS (default: auto-detect from 3MF)" },
                                ams_mapping: {
                                    type: "array",
                                    description: "AMS slot mapping array, e.g. [0, 2] maps filaments to AMS slots 0 and 2",
                                    items: { type: "number" }
                                },
                                bed_leveling: { type: "boolean", description: "Enable auto bed leveling (default: true)" },
                                flow_calibration: { type: "boolean", description: "Enable flow calibration (default: true)" },
                                vibration_calibration: { type: "boolean", description: "Enable vibration calibration (default: true)" },
                                timelapse: { type: "boolean", description: "Enable timelapse recording (default: false)" },
                                nozzle_diameter: { type: "string", description: "Nozzle diameter in mm for auto-slicing (default: 0.4)" }
                            },
                            required: ["three_mf_path", "bambu_model"]
                        }
                    },
                    {
                        name: "merge_vertices",
                        description: "Merge vertices in an STL file closer than the specified tolerance",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file" },
                                tolerance: { type: "number", description: "Max distance to merge (mm, default: 0.01)" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "center_model",
                        description: "Translate the model so its geometric center is at the origin (0,0,0)",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "lay_flat",
                        description: "Rotate the model so its largest flat face lies on the XY plane (Z=0)",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the STL file" }
                            },
                            required: ["stl_path"]
                        }
                    },
                    {
                        name: "blender_mcp_edit_model",
                        description: "Send STL-edit instructions to a Blender MCP bridge command for advanced model edits",
                        inputSchema: {
                            type: "object",
                            properties: {
                                stl_path: { type: "string", description: "Path to the local STL file" },
                                operations: {
                                    type: "array",
                                    description: "Ordered edit operations for Blender (e.g. remesh, boolean, decimate)",
                                    items: { type: "string" }
                                },
                                bridge_command: { type: "string", description: "Override command for invoking Blender MCP bridge" },
                                execute: { type: "boolean", description: "Execute bridge command (true) or return payload only (false)" }
                            },
                            required: ["stl_path", "operations"]
                        }
                    }
                ]
            };
        });
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const host = String(args?.host || DEFAULT_HOST);
            const bambuSerial = String(args?.bambu_serial || DEFAULT_BAMBU_SERIAL);
            const bambuToken = String(args?.bambu_token || DEFAULT_BAMBU_TOKEN);
            const slicerType = String(args?.slicer_type || DEFAULT_SLICER_TYPE);
            const slicerPath = String(args?.slicer_path || DEFAULT_SLICER_PATH);
            const slicerProfile = String(args?.slicer_profile || DEFAULT_SLICER_PROFILE);
            try {
                let result;
                switch (name) {
                    case "get_printer_status":
                        result = await this.bambu.getStatus(host, bambuSerial, bambuToken);
                        break;
                    case "list_printer_files":
                        result = await this.bambu.getFiles(host, bambuSerial, bambuToken);
                        break;
                    case "upload_gcode": {
                        if (!args?.filename || !args?.gcode) {
                            throw new Error("Missing required parameters: filename and gcode");
                        }
                        const tmpPath = path.join(TEMP_DIR, String(args.filename));
                        fs.writeFileSync(tmpPath, String(args.gcode));
                        result = await this.bambu.uploadFile(host, bambuSerial, bambuToken, tmpPath, String(args.filename), false);
                        break;
                    }
                    case "upload_file":
                        if (!args?.file_path || !args?.filename) {
                            throw new Error("Missing required parameters: file_path and filename");
                        }
                        result = await this.bambu.uploadFile(host, bambuSerial, bambuToken, String(args.file_path), String(args.filename), Boolean(args.print ?? false));
                        break;
                    case "start_print_job":
                        if (!args?.filename) {
                            throw new Error("Missing required parameter: filename");
                        }
                        result = await this.bambu.startJob(host, bambuSerial, bambuToken, String(args.filename));
                        break;
                    case "cancel_print":
                        result = await this.bambu.cancelJob(host, bambuSerial, bambuToken);
                        break;
                    case "set_temperature":
                        if (!args?.component || args?.temperature === undefined) {
                            throw new Error("Missing required parameters: component and temperature");
                        }
                        result = await this.bambu.setTemperature(host, bambuSerial, bambuToken, String(args.component), Number(args.temperature));
                        break;
                    case "extend_stl_base":
                        if (!args?.stl_path || args?.extension_height === undefined) {
                            throw new Error("Missing required parameters: stl_path and extension_height");
                        }
                        result = await this.stlManipulator.extendBase(String(args.stl_path), Number(args.extension_height));
                        break;
                    case "scale_stl":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        result = await this.stlManipulator.scaleSTL(String(args.stl_path), [
                            args.scale_x !== undefined ? Number(args.scale_x) : 1.0,
                            args.scale_y !== undefined ? Number(args.scale_y) : 1.0,
                            args.scale_z !== undefined ? Number(args.scale_z) : 1.0,
                        ]);
                        break;
                    case "rotate_stl":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        result = await this.stlManipulator.rotateSTL(String(args.stl_path), [
                            args.angle_x !== undefined ? Number(args.angle_x) : 0,
                            args.angle_y !== undefined ? Number(args.angle_y) : 0,
                            args.angle_z !== undefined ? Number(args.angle_z) : 0,
                        ]);
                        break;
                    case "get_stl_info":
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        result = await this.stlManipulator.getSTLInfo(String(args.stl_path));
                        break;
                    case "slice_stl": {
                        if (!args?.stl_path) {
                            throw new Error("Missing required parameter: stl_path");
                        }
                        const sliceModel = await this.resolveBambuModel(args?.bambu_model);
                        const nozzleDiam = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
                        // Resolve printer preset for BambuStudio slicer
                        const printerPreset = BAMBU_MODEL_PRESETS[sliceModel]?.(nozzleDiam);
                        const sliceBambuOptions = {};
                        if (args?.uptodate !== undefined)
                            sliceBambuOptions.uptodate = Boolean(args.uptodate);
                        if (args?.repetitions !== undefined)
                            sliceBambuOptions.repetitions = Number(args.repetitions);
                        if (args?.orient !== undefined)
                            sliceBambuOptions.orient = Boolean(args.orient);
                        if (args?.arrange !== undefined)
                            sliceBambuOptions.arrange = Boolean(args.arrange);
                        if (args?.ensure_on_bed !== undefined)
                            sliceBambuOptions.ensureOnBed = Boolean(args.ensure_on_bed);
                        if (args?.clone_objects !== undefined)
                            sliceBambuOptions.cloneObjects = String(args.clone_objects);
                        if (args?.skip_objects !== undefined)
                            sliceBambuOptions.skipObjects = String(args.skip_objects);
                        if (args?.load_filaments !== undefined)
                            sliceBambuOptions.loadFilaments = String(args.load_filaments);
                        if (args?.load_filament_ids !== undefined)
                            sliceBambuOptions.loadFilamentIds = String(args.load_filament_ids);
                        if (args?.enable_timelapse !== undefined)
                            sliceBambuOptions.enableTimelapse = Boolean(args.enable_timelapse);
                        if (args?.allow_mix_temp !== undefined)
                            sliceBambuOptions.allowMixTemp = Boolean(args.allow_mix_temp);
                        if (args?.scale !== undefined)
                            sliceBambuOptions.scale = Number(args.scale);
                        if (args?.rotate !== undefined)
                            sliceBambuOptions.rotate = Number(args.rotate);
                        if (args?.rotate_x !== undefined)
                            sliceBambuOptions.rotateX = Number(args.rotate_x);
                        if (args?.rotate_y !== undefined)
                            sliceBambuOptions.rotateY = Number(args.rotate_y);
                        if (args?.min_save !== undefined)
                            sliceBambuOptions.minSave = Boolean(args.min_save);
                        if (args?.skip_modified_gcodes !== undefined)
                            sliceBambuOptions.skipModifiedGcodes = Boolean(args.skip_modified_gcodes);
                        if (args?.slice_plate !== undefined)
                            sliceBambuOptions.slicePlate = Number(args.slice_plate);
                        result = await this.stlManipulator.sliceSTL(String(args.stl_path), slicerType, slicerPath, slicerProfile || undefined, undefined, // progressCallback
                        printerPreset, sliceBambuOptions);
                        break;
                    }
                    case "print_3mf": {
                        if (!args?.three_mf_path) {
                            throw new Error("Missing required parameter: three_mf_path");
                        }
                        if (!bambuSerial || !bambuToken) {
                            throw new Error("Bambu serial number and access token are required for print_3mf.");
                        }
                        const printModel = await this.resolveBambuModel(args?.bambu_model);
                        const printBedType = resolveBedType(args?.bed_type);
                        const printNozzle = String(args?.nozzle_diameter || DEFAULT_NOZZLE_DIAMETER);
                        const printPreset = BAMBU_MODEL_PRESETS[printModel]?.(printNozzle);
                        let threeMFPath = String(args.three_mf_path);
                        // Auto-slice if 3MF has no gcode
                        try {
                            const JSZip = (await import('jszip')).default;
                            const zipData = fs.readFileSync(threeMFPath);
                            const zip = await JSZip.loadAsync(zipData);
                            const hasGcode = Object.keys(zip.files).some(f => f.match(/Metadata\/plate_\d+\.gcode/i) || f.endsWith('.gcode'));
                            if (!hasGcode) {
                                console.log(`3MF has no gcode — auto-slicing with ${slicerType} for ${printModel}`);
                                const autoSliceOptions = {
                                    uptodate: true,
                                    ensureOnBed: true,
                                    minSave: true,
                                    skipModifiedGcodes: true,
                                };
                                threeMFPath = await this.stlManipulator.sliceSTL(threeMFPath, slicerType, slicerPath, slicerProfile || undefined, undefined, // progressCallback
                                printPreset, autoSliceOptions);
                                console.log("Auto-sliced to: " + threeMFPath);
                            }
                        }
                        catch (sliceCheckErr) {
                            console.warn("Could not check/slice 3MF, proceeding with original:", sliceCheckErr.message);
                        }
                        const parsed3MFData = await parse3MF(threeMFPath);
                        let parsedAmsMapping;
                        if (parsed3MFData.slicerConfig?.ams_mapping) {
                            const slots = Object.values(parsed3MFData.slicerConfig.ams_mapping)
                                .filter(v => typeof v === 'number');
                            if (slots.length > 0) {
                                parsedAmsMapping = slots.sort((a, b) => a - b);
                            }
                        }
                        let finalAmsMapping = parsedAmsMapping;
                        let useAMS = args?.use_ams !== undefined ? Boolean(args.use_ams) : (!!finalAmsMapping && finalAmsMapping.length > 0);
                        if (args?.ams_mapping) {
                            let userMappingOverride;
                            if (Array.isArray(args.ams_mapping)) {
                                userMappingOverride = args.ams_mapping.filter((v) => typeof v === 'number');
                            }
                            else if (typeof args.ams_mapping === 'object') {
                                userMappingOverride = Object.values(args.ams_mapping)
                                    .filter((v) => typeof v === 'number')
                                    .sort((a, b) => a - b);
                            }
                            if (userMappingOverride && userMappingOverride.length > 0) {
                                finalAmsMapping = userMappingOverride;
                                useAMS = true;
                            }
                        }
                        if (args?.use_ams === false) {
                            finalAmsMapping = undefined;
                            useAMS = false;
                        }
                        if (!finalAmsMapping || finalAmsMapping.length === 0) {
                            useAMS = false;
                        }
                        const threeMfFilename = path.basename(threeMFPath);
                        const projectName = threeMfFilename.replace(/\.3mf$/i, '');
                        result = await this.bambu.print3mf(host, bambuSerial, bambuToken, {
                            projectName,
                            filePath: threeMFPath,
                            plateIndex: 0,
                            useAMS: useAMS,
                            amsMapping: finalAmsMapping,
                            bedType: printBedType,
                            bedLeveling: args?.bed_leveling !== undefined ? Boolean(args.bed_leveling) : undefined,
                            flowCalibration: args?.flow_calibration !== undefined ? Boolean(args.flow_calibration) : undefined,
                            vibrationCalibration: args?.vibration_calibration !== undefined ? Boolean(args.vibration_calibration) : undefined,
                            layerInspect: args?.layer_inspect !== undefined ? Boolean(args.layer_inspect) : undefined,
                            timelapse: args?.timelapse !== undefined ? Boolean(args.timelapse) : undefined,
                        });
                        result = `Print command for ${threeMfFilename} sent successfully.`;
                        break;
                    }
                    case "merge_vertices":
                        if (!args?.stl_path)
                            throw new Error("Missing required parameter: stl_path");
                        result = await this.stlManipulator.mergeVertices(String(args.stl_path), args.tolerance !== undefined ? Number(args.tolerance) : undefined);
                        break;
                    case "center_model":
                        if (!args?.stl_path)
                            throw new Error("Missing required parameter: stl_path");
                        result = await this.stlManipulator.centerModel(String(args.stl_path));
                        break;
                    case "lay_flat":
                        if (!args?.stl_path)
                            throw new Error("Missing required parameter: stl_path");
                        result = await this.stlManipulator.layFlat(String(args.stl_path));
                        break;
                    case "blender_mcp_edit_model":
                        if (!args?.stl_path || !Array.isArray(args.operations)) {
                            throw new Error("Missing required parameters: stl_path and operations");
                        }
                        result = await this.invokeBlenderBridge({
                            stlPath: String(args.stl_path),
                            operations: args.operations.map((entry) => String(entry)),
                            execute: Boolean(args.execute ?? false),
                            bridgeCommand: args.bridge_command
                                ? String(args.bridge_command)
                                : this.runtimeConfig.blenderBridgeCommand,
                        });
                        break;
                    default:
                        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
                }
                const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
                if (this.runtimeConfig.enableJsonResponse && typeof result === "object") {
                    return {
                        content: [{ type: "text", text }],
                        structuredContent: result,
                    };
                }
                return { content: [{ type: "text", text }] };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const structured = {
                    status: "error",
                    retryable: false,
                    suggestion: `Check parameters and try again. Error: ${message}`,
                    message,
                    tool: name,
                };
                return {
                    content: [{ type: "text", text: `Error: ${message}` }],
                    structuredContent: structured,
                    isError: true,
                };
            }
        });
    }
    async invokeBlenderBridge(params) {
        const payload = {
            stlPath: params.stlPath,
            operations: params.operations,
        };
        if (!params.execute || !params.bridgeCommand) {
            return {
                status: "prepared",
                payload,
                note: params.bridgeCommand
                    ? "Set execute=true to run the Blender bridge command."
                    : "No BLENDER_MCP_BRIDGE_COMMAND configured. Set the env var or pass bridge_command.",
            };
        }
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout, stderr } = await execFileAsync(params.bridgeCommand, [], {
            env: { ...process.env, MCP_BLENDER_PAYLOAD: JSON.stringify(payload) },
            timeout: 120000,
        });
        return {
            status: "executed",
            stdout: stdout.trim(),
            stderr: stderr.trim(),
        };
    }
    async startStdio() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Bambu Printer MCP server running on stdio");
    }
    async startHttp() {
        const { httpHost, httpPort, httpPath, statefulSession, enableJsonResponse, allowedOrigins } = this.runtimeConfig;
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: statefulSession ? () => randomUUID() : undefined,
            enableJsonResponse,
        });
        await this.server.connect(transport);
        const httpServer = createHttpServer(async (req, res) => {
            const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
            if (url.pathname !== httpPath) {
                res.writeHead(404);
                res.end("Not found");
                return;
            }
            if (allowedOrigins.size > 0) {
                const origin = req.headers.origin ?? "";
                if (origin && !allowedOrigins.has(origin)) {
                    res.writeHead(403);
                    res.end("Forbidden");
                    return;
                }
            }
            await transport.handleRequest(req, res);
        });
        httpServer.listen(httpPort, httpHost, () => {
            console.error(`Bambu Printer MCP server running on http://${httpHost}:${httpPort}${httpPath}`);
        });
        this.httpRuntime = { transport, httpServer };
    }
    async run() {
        if (this.runtimeConfig.transport === "streamable-http") {
            await this.startHttp();
        }
        else {
            await this.startStdio();
        }
    }
}
const server = new BambuPrinterMCPServer();
server.run().catch(console.error);
