# bambu-printer-mcp

MCP server for Bambu Lab 3D printers. Provides STL manipulation, BambuStudio slicing, and direct printer control over MQTT/FTP.

Stripped-down, Bambu-focused fork of [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server).

## Features

- **Printer control**: status, cancel, temperature, file management via MQTT (bambu-node)
- **Print 3MF**: upload via FTP, send `project_file` command with proper AMS mapping
- **Auto-slice**: unsliced 3MF files are automatically sliced with BambuStudio CLI
- **STL tools**: scale, rotate, extend base, merge vertices, center, lay flat, info
- **Blender bridge**: optional integration for advanced model edits
- **Transports**: stdio and Streamable HTTP

## Quick Start

```bash
npx bambu-printer-mcp
```

Or install globally:

```bash
npm install -g bambu-printer-mcp
```

### Claude Desktop config

```json
{
  "mcpServers": {
    "bambu-printer": {
      "command": "npx",
      "args": ["-y", "bambu-printer-mcp"],
      "env": {
        "PRINTER_HOST": "192.168.1.100",
        "BAMBU_SERIAL": "your_serial",
        "BAMBU_TOKEN": "your_token"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRINTER_HOST` | `localhost` | Printer IP address |
| `BAMBU_SERIAL` | | Printer serial number |
| `BAMBU_TOKEN` | | Printer access token |
| `SLICER_PATH` | BambuStudio macOS path | Path to slicer executable |
| `SLICER_PROFILE` | | Path to slicer profile |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `streamable-http` |

## Tools

### Printer
- `get_printer_status` - Temperatures, print progress, AMS status
- `print_3mf` - Upload and print a 3MF file (auto-slices if needed)
- `cancel_print` - Cancel current print
- `set_temperature` - Set bed/nozzle temperature
- `start_print_job` - Start a gcode file already on the printer
- `upload_file` / `upload_gcode` - Upload files to printer
- `list_printer_files` - List files on printer SD card

### STL Manipulation
- `get_stl_info` - Bounding box, face count, dimensions
- `scale_stl` - Scale by X/Y/Z factors
- `rotate_stl` - Rotate by X/Y/Z angles
- `extend_stl_base` - Extend the base of a model
- `merge_vertices` - Merge close vertices
- `center_model` - Center at origin
- `lay_flat` - Orient largest face down

### Slicing
- `slice_stl` - Slice STL/3MF with BambuStudio (or PrusaSlicer, OrcaSlicer, Cura)

### Advanced
- `blender_mcp_edit_model` - Bridge to Blender MCP for advanced edits

## License

GPL-2.0
