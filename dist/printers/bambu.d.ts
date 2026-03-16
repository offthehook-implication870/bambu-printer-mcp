interface BambuPrintOptionsInternal {
    projectName: string;
    filePath: string;
    useAMS?: boolean;
    plateIndex?: number;
    bedType?: string;
    bedLeveling?: boolean;
    flowCalibration?: boolean;
    vibrationCalibration?: boolean;
    layerInspect?: boolean;
    timelapse?: boolean;
    amsMapping?: number[];
    md5?: string;
}
export declare class BambuImplementation {
    private printerStore;
    constructor();
    private getPrinter;
    private resolveProjectFileMetadata;
    getStatus(host: string, serial: string, token: string): Promise<any>;
    print3mf(host: string, serial: string, token: string, options: BambuPrintOptionsInternal): Promise<any>;
    cancelJob(host: string, serial: string, token: string): Promise<any>;
    setTemperature(host: string, serial: string, token: string, component: string, temperature: number): Promise<{
        status: string;
        message: string;
        command: string;
    }>;
    getFiles(host: string, serial: string, token: string): Promise<{
        files: string[];
        directories: Record<string, string[]>;
    }>;
    getFile(host: string, serial: string, token: string, filename: string): Promise<{
        name: string;
        exists: boolean;
    }>;
    uploadFile(host: string, serial: string, token: string, filePath: string, filename: string, print: boolean): Promise<Record<string, unknown>>;
    startJob(host: string, serial: string, token: string, filename: string): Promise<{
        status: string;
        message: string;
        file: string;
    }>;
    /**
     * Upload a file to the printer via FTP using basic-ftp directly.
     * Bypasses bambu-js's sendFile which has a double-path bug (ensureDir CDs
     * into the target directory, then uploadFrom uses the full relative path
     * again, resulting in e.g. /cache/cache/file.3mf).
     */
    private ftpUpload;
    disconnectAll(): Promise<void>;
}
export {};
