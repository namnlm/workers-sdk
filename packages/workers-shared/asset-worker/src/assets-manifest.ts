export type AssetEntry = {
	path: string;
	contentHash: string;
};

export class AssetsManifest {
	private data: ArrayBuffer;

	constructor(data: ArrayBuffer) {
		this.data = data;
	}

	async get(pathname: string) {
		return Promise.resolve(pathname);
	}
}
