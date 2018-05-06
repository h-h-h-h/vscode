/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/workbench/browser/parts/editor/editor.contribution';
import { IThemeService, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { Part } from 'vs/workbench/browser/part';
import { Dimension, isAncestor, toggleClass, addClass } from 'vs/base/browser/dom';
import { Event, Emitter, once } from 'vs/base/common/event';
import { contrastBorder, editorBackground } from 'vs/platform/theme/common/colorRegistry';
import { INextEditorGroupsService, GroupDirection } from 'vs/workbench/services/editor/common/nextEditorGroupsService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Direction, SerializableGrid } from 'vs/base/browser/ui/grid/grid';
import { GroupIdentifier, IWorkbenchEditorConfiguration } from 'vs/workbench/common/editor';
import { values } from 'vs/base/common/map';
import { EDITOR_GROUP_BORDER } from 'vs/workbench/common/theme';
import { distinct } from 'vs/base/common/arrays';
import { INextEditorGroupsAccessor, INextEditorGroupView, INextEditorPartOptions, getEditorPartOptions, impactsEditorPartOptions, INextEditorPartOptionsChangeEvent } from 'vs/workbench/browser/parts/editor2/editor2';
import { NextEditorGroupView } from 'vs/workbench/browser/parts/editor2/nextEditorGroupView';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { IDisposable, dispose, toDisposable } from 'vs/base/common/lifecycle';
import { assign } from 'vs/base/common/objects';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { Scope } from 'vs/workbench/common/memento';
import { ISerializedEditorGroup, isSerializedEditorGroup } from 'vs/workbench/common/editor/editorStacksModel';

// TODO@grid provide DND support of groups/editors:
// - editor: move/copy to existing group, move/copy to new split group (up, down, left, right)
// - group: move/copy to existing group (merges?), move/copy to new split group (up, down, left, right)

// TODO@grid enable double click on sash to even out widths in one dimension

// TODO@grid enable minimized/maximized groups in one dimension

interface INextEditorPartUIState {
	serializedGrid: object;
	activeGroup: GroupIdentifier;
	mostRecentActiveGroups: GroupIdentifier[];
}

export class NextEditorPart extends Part implements INextEditorGroupsService, INextEditorGroupsAccessor {

	_serviceBrand: any;

	private static readonly NEXT_EDITOR_PART_UI_STATE_STORAGE_KEY = 'nexteditorpart.uiState';

	//#region Events

	private _onDidLayout: Emitter<Dimension> = this._register(new Emitter<Dimension>());
	get onDidLayout(): Event<Dimension> { return this._onDidLayout.event; }

	private _onDidActiveGroupChange: Emitter<INextEditorGroupView> = this._register(new Emitter<INextEditorGroupView>());
	get onDidActiveGroupChange(): Event<INextEditorGroupView> { return this._onDidActiveGroupChange.event; }

	private _onDidAddGroup: Emitter<INextEditorGroupView> = this._register(new Emitter<INextEditorGroupView>());
	get onDidAddGroup(): Event<INextEditorGroupView> { return this._onDidAddGroup.event; }

	private _onDidRemoveGroup: Emitter<INextEditorGroupView> = this._register(new Emitter<INextEditorGroupView>());
	get onDidRemoveGroup(): Event<INextEditorGroupView> { return this._onDidRemoveGroup.event; }

	//#endregion

	private memento: object;
	private dimension: Dimension;
	private _partOptions: INextEditorPartOptions;

	private _activeGroup: INextEditorGroupView;
	private groupViews: Map<GroupIdentifier, INextEditorGroupView> = new Map<GroupIdentifier, INextEditorGroupView>();
	private mostRecentActiveGroups: GroupIdentifier[] = [];

	private container: HTMLElement;
	private gridWidget: SerializableGrid<INextEditorGroupView>;

	constructor(
		id: string,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IStorageService private storageService: IStorageService
	) {
		super(id, { hasTitle: false }, themeService);

		this._partOptions = getEditorPartOptions(this.configurationService.getValue<IWorkbenchEditorConfiguration>());
		this.memento = this.getMemento(this.storageService, Scope.WORKSPACE);

		this.registerListeners();
	}

	//#region IEditorPartOptions

	private enforcedPartOptions: INextEditorPartOptions[] = [];

	private _onDidEditorPartOptionsChange: Emitter<INextEditorPartOptionsChangeEvent> = this._register(new Emitter<INextEditorPartOptionsChangeEvent>());
	get onDidEditorPartOptionsChange(): Event<INextEditorPartOptionsChangeEvent> { return this._onDidEditorPartOptionsChange.event; }

	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationUpdated(e)));
	}

	private onConfigurationUpdated(event: IConfigurationChangeEvent): void {
		if (impactsEditorPartOptions(event)) {
			this.handleChangedPartOptions();
		}
	}

	private handleChangedPartOptions(): void {
		const oldPartOptions = this._partOptions;

		const newPartOptions = getEditorPartOptions(this.configurationService.getValue<IWorkbenchEditorConfiguration>());

		this.enforcedPartOptions.forEach(enforcedPartOptions => {
			assign(newPartOptions, enforcedPartOptions); // check for overrides
		});

		this._partOptions = newPartOptions;

		this._onDidEditorPartOptionsChange.fire({ oldPartOptions, newPartOptions });
	}

	get partOptions(): INextEditorPartOptions {
		return this._partOptions;
	}

	enforcePartOptions(options: INextEditorPartOptions): IDisposable {
		this.enforcedPartOptions.push(options);
		this.handleChangedPartOptions();

		return toDisposable(() => {
			this.enforcedPartOptions.splice(this.enforcedPartOptions.indexOf(options), 1);
			this.handleChangedPartOptions();
		});
	}

	//#endregion

	//#region INextEditorGroupsService

	get activeGroup(): INextEditorGroupView {
		return this._activeGroup;
	}

	get groups(): INextEditorGroupView[] {
		return values(this.groupViews);
	}

	get count(): number {
		return this.groupViews.size;
	}

	getGroups(sortByMostRecentlyActive?: boolean): INextEditorGroupView[] {
		if (!sortByMostRecentlyActive) {
			return this.groups;
		}

		const mostRecentActive = this.mostRecentActiveGroups.map(groupId => this.getGroup(groupId));

		// there can be groups that got never active, even though they exist. in this case
		// make sure to ust append them at the end so that all groups are returned properly
		return distinct([...mostRecentActive, ...this.groups]);
	}

	getGroup(identifier: GroupIdentifier): INextEditorGroupView {
		return this.groupViews.get(identifier);
	}

	activateGroup(group: INextEditorGroupView | GroupIdentifier): INextEditorGroupView {
		const groupView = this.asGroupView(group);
		if (groupView) {
			this.doSetGroupActive(groupView);
		}

		return groupView;
	}

	focusGroup(group: INextEditorGroupView | GroupIdentifier): INextEditorGroupView {
		const groupView = this.asGroupView(group);
		if (groupView) {
			groupView.focus();
		}

		return groupView;
	}

	addGroup(fromGroup: INextEditorGroupView | GroupIdentifier, direction: GroupDirection, copy?: boolean): INextEditorGroupView {
		const fromGroupView = this.asGroupView(fromGroup);
		const newGroupView = this.doCreateGroupView(copy ? fromGroupView : void 0);

		// Add to grid widget
		this.gridWidget.addView(
			newGroupView,
			direction === GroupDirection.DOWN ? fromGroupView.dimension.height / 2 : fromGroupView.dimension.width / 2 /* TODO@grid what size? */,
			fromGroupView,
			this.toGridViewDirection(direction),
		);

		// Update container
		this.updateContainer();

		return newGroupView;
	}

	private doCreateGroupView(from?: INextEditorGroupView | ISerializedEditorGroup): INextEditorGroupView {

		// Create group view
		let groupView: INextEditorGroupView;
		if (from instanceof NextEditorGroupView) {
			groupView = NextEditorGroupView.createCopy(from, this, this.instantiationService);
		} else if (isSerializedEditorGroup(from)) {
			groupView = NextEditorGroupView.createFromSerialized(from, this, this.instantiationService);
		} else {
			groupView = NextEditorGroupView.createNew(this, this.instantiationService);
		}

		// Keep in map
		this.groupViews.set(groupView.id, groupView);

		// Track focus
		let groupDisposables: IDisposable[] = [];
		groupDisposables.push(groupView.onDidFocus(() => {
			this.doSetGroupActive(groupView);
		}));

		// Track editor change
		groupDisposables.push(groupView.onDidActiveEditorChange(() => {
			this.updateContainer();
		}));

		// Track dispose
		once(groupView.onWillDispose)(() => {
			groupDisposables = dispose(groupDisposables);
			this.groupViews.delete(groupView.id);
			this.doUpdateMostRecentActive(groupView);
		});

		// Event
		this._onDidAddGroup.fire(groupView);

		// TODO@grid if the view gets minimized, the previous active group should become active

		return groupView;
	}

	private doSetGroupActive(group: INextEditorGroupView): void {
		if (this._activeGroup === group) {
			return; // return if this is already the active group
		}

		const previousActiveGroup = this._activeGroup;
		this._activeGroup = group;

		// Update list of most recently active groups
		this.doUpdateMostRecentActive(group, true);

		// Mark previous one as inactive
		if (previousActiveGroup) {
			previousActiveGroup.setActive(false);
		}

		// Mark group as new active
		group.setActive(true);

		// Event
		this._onDidActiveGroupChange.fire(group);

		// TODO@grid if the group is minimized, it should now restore to be maximized
	}

	private doUpdateMostRecentActive(group: INextEditorGroupView, makeMostRecentlyActive?: boolean): void {
		const index = this.mostRecentActiveGroups.indexOf(group.id);

		// Remove from MRU list
		if (index !== -1) {
			this.mostRecentActiveGroups.splice(index, 1);
		}

		// Add to front as needed
		if (makeMostRecentlyActive) {
			this.mostRecentActiveGroups.unshift(group.id);
		}
	}

	removeGroup(group: INextEditorGroupView | GroupIdentifier): void {
		const groupView = this.asGroupView(group);
		if (
			!groupView ||
			this.groupViews.size === 1 ||	// Cannot remove the last root group
			!groupView.isEmpty()			// TODO@grid what about removing a group with editors, move them to other group?
		) {
			return;
		}

		const groupHasFocus = isAncestor(document.activeElement, groupView.element);

		// Activate next group if the removed one was active
		if (this._activeGroup === groupView) {
			const mostRecentlyActiveGroups = this.getGroups(true);
			const nextActiveGroup = mostRecentlyActiveGroups[1]; // [0] will be the current group we are about to dispose
			this.activateGroup(nextActiveGroup);
		}

		// Remove from grid widget & dispose
		this.gridWidget.removeView(groupView);
		groupView.dispose();

		// Restore focus if we had it previously (we run this after gridWidget.removeView() is called
		// because removing a view can mean to reparent it and thus focus would be removed otherwise)
		if (groupHasFocus) {
			this._activeGroup.focus();
		}

		// Update container
		this.updateContainer();

		// Event
		this._onDidRemoveGroup.fire(groupView);
	}

	private toGridViewDirection(direction: GroupDirection): Direction {
		switch (direction) {
			case GroupDirection.UP: return Direction.Up;
			case GroupDirection.DOWN: return Direction.Down;
			case GroupDirection.LEFT: return Direction.Left;
			case GroupDirection.RIGHT: return Direction.Right;
		}
	}

	private asGroupView(group: INextEditorGroupView | GroupIdentifier): INextEditorGroupView {
		if (typeof group === 'number') {
			return this.getGroup(group);
		}

		return group;
	}

	//#endregion

	//#region Part

	protected updateStyles(): void {

		// Part container
		const container = this.getContainer();
		container.style.backgroundColor = this.getColor(editorBackground);
	}

	createContentArea(parent: HTMLElement): HTMLElement {

		// Container
		this.container = document.createElement('div');
		addClass(this.container, 'content');
		parent.appendChild(this.container);

		// Grid control
		this.doCreateGridControl(this.container);

		return this.container;
	}

	private doCreateGridControl(container: HTMLElement): void {

		// Grid Widget (restored from previous UI state)
		const uiState = this.memento[NextEditorPart.NEXT_EDITOR_PART_UI_STATE_STORAGE_KEY] as INextEditorPartUIState;
		if (uiState && uiState.serializedGrid) {
			this.mostRecentActiveGroups = uiState.mostRecentActiveGroups;
			this.gridWidget = this._register(SerializableGrid.deserialize(container, uiState.serializedGrid, {
				fromJSON: (serializedEditorGroup: ISerializedEditorGroup) => {
					const groupView = this.doCreateGroupView(serializedEditorGroup);
					if (groupView.id === uiState.activeGroup) {
						this.doSetGroupActive(groupView);
					}

					return groupView;
				}
			}));

			// Ensure last active group has focus
			this.activeGroup.focus();
		}

		// Grid Widget (no previous UI state)
		else {
			const initialGroup = this.doCreateGroupView();
			this.gridWidget = this._register(new SerializableGrid(container, initialGroup));

			// Ensure a group is active
			this.doSetGroupActive(initialGroup);
		}

		// Update container
		this.updateContainer();
	}

	private updateContainer(): void {
		toggleClass(this.container, 'empty', this.groupViews.size === 1 && this.activeGroup.isEmpty());
	}

	layout(dimension: Dimension): Dimension[] {
		const sizes = super.layout(dimension);

		this.dimension = sizes[1];

		// Layout Grid
		this.gridWidget.layout(this.dimension.width, this.dimension.height);

		// Event
		this._onDidLayout.fire(dimension);

		return sizes;
	}

	shutdown(): void {

		// Persist grid UI state
		const uiState: INextEditorPartUIState = {
			serializedGrid: this.gridWidget.serialize(),
			activeGroup: this._activeGroup.id,
			mostRecentActiveGroups: this.mostRecentActiveGroups
		};

		if (this.count === 1 && this.activeGroup.isEmpty()) {
			delete this.memento[NextEditorPart.NEXT_EDITOR_PART_UI_STATE_STORAGE_KEY];
		} else {
			this.memento[NextEditorPart.NEXT_EDITOR_PART_UI_STATE_STORAGE_KEY] = uiState;
		}

		// Forward to all groups
		this.groupViews.forEach(group => group.shutdown());

		super.shutdown();
	}

	dispose(): void {

		// Forward to all groups
		this.groupViews.forEach(group => group.dispose());
		this.groupViews.clear();

		super.dispose();
	}

	//#endregion
}

// Group borders (TODO@grid this should be a color the GridView exposes)
registerThemingParticipant((theme, collector) => {
	const groupBorderColor = theme.getColor(EDITOR_GROUP_BORDER) || theme.getColor(contrastBorder);
	if (groupBorderColor) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .split-view-view {
				position: relative;
			}

			.monaco-workbench > .part.editor > .content .monaco-grid-view .monaco-split-view2 > .split-view-container > .split-view-view:not(:first-child)::before {
				content: '';
				position: absolute;
				top: 0;
				left: 0;
				z-index: 100;
				pointer-events: none;
				background: ${groupBorderColor}
			}

			.monaco-workbench > .part.editor > .content .monaco-grid-view .monaco-split-view2.horizontal > .split-view-container>.split-view-view:not(:first-child)::before {
				height: 100%;
				width: 1px;
			}

			.monaco-workbench > .part.editor > .content .monaco-grid-view .monaco-split-view2.vertical > .split-view-container > .split-view-view:not(:first-child)::before {
				height: 1px;
				width: 100%;
			}
		`);
	}
});