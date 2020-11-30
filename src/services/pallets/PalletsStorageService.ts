import { Text } from '@polkadot/types';
import {
	BlockHash,
	ModuleMetadataV12,
	StorageEntryMetadataV12,
} from '@polkadot/types/interfaces';
import { BadRequest, InternalServerError } from 'http-errors';
import {
	IPalletStorage,
	IPalletStorageItem,
	ISanitizedStorageItemMetadata,
} from 'src/types/responses';

import { sanitizeNumbers } from '../../sanitize/sanitizeNumbers';
import { AbstractService } from '../AbstractService';

interface IFetchPalletArgs {
	hash: BlockHash;
	palletId: string;
}

interface IFetchStorageItemArgs extends IFetchPalletArgs {
	storageItemId: string;
	key1: string | undefined;
	key2: string | undefined;
	metadata: boolean;
}

function cannotFindPalletId(palletId: string) {
	throw new BadRequest(
		`"${palletId}" was not recognized as a queryable pallet. Pallet names are expected to be in camel case, e.g. 'palletId`
	);
}

export class PalletsStorageService extends AbstractService {
	async fetchStorageItem({
		hash,
		palletId,
		storageItemId,
		key1,
		key2,
		metadata,
	}: IFetchStorageItemArgs): Promise<IPalletStorageItem> {
		if (!this.api.query[palletId]) {
			cannotFindPalletId(palletId);
		}

		if (!this.api.query[palletId][storageItemId]) {
			throw new BadRequest(
				`"${storageItemId}" was not recognized as queryable storage item for ${palletId}. Storage item names are expected to be in camel case, e.g. 'storageItemId'`
			);
		}

		const [palletMeta, palletMetaIdx] = this.findPalletMeta(palletId);

		let normalizedStorageItemMeta;
		if (metadata) {
			const storageItemMeta = this.findStorageItemMeta(
				palletMeta,
				storageItemId
			);

			normalizedStorageItemMeta = this.normalizeStorageItemMeta(
				storageItemMeta
			);
		}

		const [value, { number }] = await Promise.all([
			this.api.query[palletId][storageItemId].at(hash, key1, key2),
			this.api.rpc.chain.getHeader(hash),
		]);

		return {
			at: {
				hash: hash,
				height: number.unwrap().toString(10),
			},
			pallet: palletId,
			palletIndex: palletMetaIdx,
			storageItem: storageItemId,
			key1,
			key2,
			value,
			metadata: normalizedStorageItemMeta,
		};
	}

	async fetchStorage({
		hash,
		palletId,
		onlyIds,
	}: IFetchPalletArgs & { onlyIds: boolean }): Promise<IPalletStorage> {
		if (!this.api.query[palletId]) {
			cannotFindPalletId(palletId);
		}

		const { number } = await this.api.rpc.chain.getHeader(hash);

		const [palletMeta, palletMetaIdx] = this.findPalletMeta(palletId);

		let items: [] | ISanitizedStorageItemMetadata[] | Text[];
		if (palletMeta.storage.isNone) {
			items = [];
		} else if (onlyIds) {
			items = palletMeta.storage
				.unwrap()
				.items.map((itemMeta) => itemMeta.name);
		} else {
			items = palletMeta.storage
				.unwrap()
				.items.map((itemMeta) =>
					this.normalizeStorageItemMeta(itemMeta)
				);
		}

		return {
			at: {
				hash: hash,
				height: number.unwrap().toString(10),
			},
			pallet: palletId,
			palletIndex: palletMetaIdx,
			items,
		};
	}

	/**
	 * Normalize storage item metadata by running it through `sanitizeNumbers` and
	 * converting the docs section from an array of strings to a single string
	 * joined with new line characters.
	 *
	 * @param storageItemMeta polkadot-js StorageEntryMetadataV12
	 */
	private normalizeStorageItemMeta(
		storageItemMeta: StorageEntryMetadataV12
	): ISanitizedStorageItemMetadata {
		const normalizedStorageItemMeta = (sanitizeNumbers(
			storageItemMeta
		) as unknown) as ISanitizedStorageItemMetadata;

		normalizedStorageItemMeta.documentation = this.sanitizeDocs(
			storageItemMeta.documentation
		);

		return normalizedStorageItemMeta;
	}

	/**
	 * Find the storage item's metadata within the pallets's metadata.
	 *
	 * @param palletMeta the metadata of the pallet that contains the storage item
	 * @param storageId name of the storage item in camel or pascal case
	 */
	private findStorageItemMeta(
		palletMeta: ModuleMetadataV12,
		storageItemId: string
	): StorageEntryMetadataV12 {
		if (palletMeta.storage.isNone) {
			throw new InternalServerError(
				`No storage items found in ${palletMeta.name.toString()}'s metadata`
			);
		}
		const palletMetaStorage = palletMeta.storage.unwrap().items;
		const storageItemMetaIdx = palletMetaStorage.findIndex(
			(item) => item.name.toLowerCase() === storageItemId.toLowerCase()
		);
		if (storageItemMetaIdx === -1) {
			throw new InternalServerError(
				`Could not find storage item ("${storageItemId}") in metadata.`
			);
		}

		return palletMetaStorage[storageItemMetaIdx];
	}

	/**
	 * Find a pallet's metadata info.
	 *
	 * @param palletId identifier for a FRAME pallet.
	 */
	private findPalletMeta(palletId: string): [ModuleMetadataV12, number] {
		const { modules } = this.api.runtimeMetadata.asLatest;

		const filtered = modules.filter((mod) => mod.storage.isSome);

		let palletMeta: ModuleMetadataV12 | undefined;
		let palletIdx: number | undefined;
		for (const [_sectionIdx, section] of filtered.entries()) {
			if (section.name.toLowerCase() === palletId.toLowerCase()) {
				// ModuleMetadataV11 and lower have a `index` but they use 255 as a reserve value to signify
				// that they are meaningless. So if the index is 255 we use its index in the filtered array
				// of modules. But if the index is something else than we use `ModuleMetadataV12.index`.
				// The reason they use a reserve value is that all previous ModuleMetadata versions actually
				// extend the latest. So since the intro of ModuleMetadataV12 all versions have `index` in
				// polkadot-js, but at the substrate level, only versions >= 12 have pallet `index`.
				// https://github.com/polkadot-js/api/pull/2599
				// https://github.com/paritytech/substrate/pull/6969
				// https://github.com/polkadot-js/api/issues/2596
				palletIdx = section.index.eqn(255)
					? _sectionIdx
					: section.index.toNumber();
				palletMeta = section;
				break;
			}
		}

		if (!palletMeta || palletIdx === undefined || palletIdx < 0) {
			throw new InternalServerError(
				`Could not find pallet ("${palletId}")in metadata.`
			);
		}

		return [palletMeta, palletIdx];
	}
}
