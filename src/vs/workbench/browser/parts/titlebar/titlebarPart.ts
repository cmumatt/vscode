/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/titlebarpart';
import { localize } from 'vs/nls';
import { dirname, basename } from 'vs/base/common/resources';
import { Part } from 'vs/workbench/browser/part';
import { ITitleService, ITitleProperties } from 'vs/workbench/services/title/common/titleService';
import { getZoomFactor } from 'vs/base/browser/browser';
import { MenuBarVisibility, getTitleBarStyle, getMenuBarVisibility } from 'vs/platform/window/common/window';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { IAction, toAction } from 'vs/base/common/actions';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { DisposableStore, dispose, toDisposable } from 'vs/base/common/lifecycle';
import { EditorResourceAccessor, Verbosity, SideBySideEditor } from 'vs/workbench/common/editor';
import { IBrowserWorkbenchEnvironmentService } from 'vs/workbench/services/environment/browser/environmentService';
import { IWorkspaceContextService, WorkbenchState, IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IThemeService, registerThemingParticipant, ThemeIcon } from 'vs/platform/theme/common/themeService';
import { TITLE_BAR_ACTIVE_BACKGROUND, TITLE_BAR_ACTIVE_FOREGROUND, TITLE_BAR_INACTIVE_FOREGROUND, TITLE_BAR_INACTIVE_BACKGROUND, TITLE_BAR_BORDER, WORKBENCH_BACKGROUND } from 'vs/workbench/common/theme';
import { isMacintosh, isWindows, isLinux, isWeb } from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import { Color } from 'vs/base/common/color';
import { trim } from 'vs/base/common/strings';
import { EventType, EventHelper, Dimension, isAncestor, append, $, addDisposableListener, runAtThisOrScheduleAtNextAnimationFrame, prepend, clearNode } from 'vs/base/browser/dom';
import { CustomMenubarControl } from 'vs/workbench/browser/parts/titlebar/menubarControl';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { template } from 'vs/base/common/labels';
import { ILabelService } from 'vs/platform/label/common/label';
import { Emitter } from 'vs/base/common/event';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { Parts, IWorkbenchLayoutService } from 'vs/workbench/services/layout/browser/layoutService';
import { RunOnceScheduler } from 'vs/base/common/async';
import { createActionViewItem, createAndFillInContextMenuActions, DropdownWithDefaultActionViewItem } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { IMenuService, IMenu, MenuId, SubmenuItemAction, MenuRegistry } from 'vs/platform/actions/common/actions';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IHostService } from 'vs/workbench/services/host/browser/host';
import { IProductService } from 'vs/platform/product/common/productService';
import { Schemas } from 'vs/base/common/network';
import { withNullAsUndefined } from 'vs/base/common/types';
import { Codicon } from 'vs/base/common/codicons';
import { getVirtualWorkspaceLocation } from 'vs/platform/workspace/common/virtualWorkspace';
import { getIconRegistry } from 'vs/platform/theme/common/iconRegistry';
import { ToolBar } from 'vs/base/browser/ui/toolbar/toolbar';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';

export class TitlebarPart extends Part implements ITitleService {

	private static readonly NLS_UNSUPPORTED = localize('patchedWindowTitle', "[Unsupported]");
	private static readonly NLS_USER_IS_ADMIN = isWindows ? localize('userIsAdmin', "[Administrator]") : localize('userIsSudo', "[Superuser]");
	private static readonly NLS_EXTENSION_HOST = localize('devExtensionWindowTitlePrefix', "[Extension Development Host]");
	private static readonly TITLE_DIRTY = '\u25cf ';

	//#region IView

	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	get minimumHeight(): number { return 30 / (this.currentMenubarVisibility === 'hidden' || getZoomFactor() < 1 ? getZoomFactor() : 1); }
	get maximumHeight(): number { return this.minimumHeight; }

	//#endregion

	private _onMenubarVisibilityChange = this._register(new Emitter<boolean>());
	readonly onMenubarVisibilityChange = this._onMenubarVisibilityChange.event;

	declare readonly _serviceBrand: undefined;

	protected rootContainer!: HTMLElement;
	protected windowControls: HTMLElement | undefined;
	protected readonly titleMenuElement: HTMLElement = $('div.title-menu');
	protected title!: HTMLElement;

	protected customMenubar: CustomMenubarControl | undefined;
	protected appIcon: HTMLElement | undefined;
	private appIconBadge: HTMLElement | undefined;
	protected menubar?: HTMLElement;
	protected layoutControls: HTMLElement | undefined;
	private layoutToolbar: ToolBar | undefined;
	protected lastLayoutDimensions: Dimension | undefined;

	private readonly titleMenuDisposables = this._register(new DisposableStore());
	private titleBarStyle: 'native' | 'custom';

	private pendingTitle: string | undefined;

	private isInactive: boolean = false;

	private readonly properties: ITitleProperties = { isPure: true, isAdmin: false, prefix: undefined };
	private readonly activeEditorListeners = this._register(new DisposableStore());

	private readonly titleUpdater = this._register(new RunOnceScheduler(() => this.doUpdateTitle(), 0));
	private readonly onDidUpdateTitle = new Emitter<void>();

	private contextMenu: IMenu;

	constructor(
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IBrowserWorkbenchEnvironmentService protected readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@ILabelService private readonly labelService: ILabelService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHostService private readonly hostService: IHostService,
		@IProductService private readonly productService: IProductService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(Parts.TITLEBAR_PART, { hasTitle: false }, themeService, storageService, layoutService);

		this.contextMenu = this._register(menuService.createMenu(MenuId.TitleBarContext, contextKeyService));

		this.titleBarStyle = getTitleBarStyle(this.configurationService);

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.hostService.onDidChangeFocus(focused => focused ? this.onFocus() : this.onBlur()));
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationChanged(e)));
		this._register(this.editorService.onDidActiveEditorChange(() => this.onActiveEditorChange()));
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.titleUpdater.schedule()));
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.titleUpdater.schedule()));
		this._register(this.contextService.onDidChangeWorkspaceName(() => this.titleUpdater.schedule()));
		this._register(this.labelService.onDidChangeFormatters(() => this.titleUpdater.schedule()));
	}

	private onBlur(): void {
		this.isInactive = true;
		this.updateStyles();
	}

	private onFocus(): void {
		this.isInactive = false;
		this.updateStyles();
	}

	protected onConfigurationChanged(event: IConfigurationChangeEvent): void {
		if (event.affectsConfiguration('window.title') || event.affectsConfiguration('window.titleSeparator')) {
			this.titleUpdater.schedule();
		}

		if (this.titleBarStyle !== 'native' && (!isMacintosh || isWeb)) {
			if (event.affectsConfiguration('window.menuBarVisibility')) {
				if (this.currentMenubarVisibility === 'compact') {
					this.uninstallMenubar();
				} else {
					this.installMenubar();
				}
			}
		}

		if (this.titleBarStyle !== 'native' && this.layoutControls && event.affectsConfiguration('workbench.layoutControl.enabled')) {
			this.layoutControls.classList.toggle('show-layout-control', this.layoutControlEnabled);
		}

		if (event.affectsConfiguration('window.experimental.titleMenu')) {
			this.updateTitleMenu();
		}
	}

	protected onMenubarVisibilityChanged(visible: boolean): void {
		if (isWeb || isWindows || isLinux) {
			this.adjustTitleMarginToCenter();

			this._onMenubarVisibilityChange.fire(visible);
		}
	}

	private onActiveEditorChange(): void {

		// Dispose old listeners
		this.activeEditorListeners.clear();

		// Calculate New Window Title
		this.titleUpdater.schedule();

		// Apply listener for dirty and label changes
		const activeEditor = this.editorService.activeEditor;
		if (activeEditor) {
			this.activeEditorListeners.add(activeEditor.onDidChangeDirty(() => this.titleUpdater.schedule()));
			this.activeEditorListeners.add(activeEditor.onDidChangeLabel(() => this.titleUpdater.schedule()));
		}
	}

	private doUpdateTitle(): void {
		const title = this.getWindowTitle();

		// Always set the native window title to identify us properly to the OS
		let nativeTitle = title;
		if (!trim(nativeTitle)) {
			nativeTitle = this.productService.nameLong;
		}
		window.document.title = nativeTitle;

		// Apply custom title if we can
		if (this.title) {
			this.title.innerText = title;
		} else {
			this.pendingTitle = title;
		}

		if (this.lastLayoutDimensions) {
			this.updateLayout(this.lastLayoutDimensions);
		}

		this.onDidUpdateTitle.fire();
	}

	private getWindowTitle(): string {
		let title = this.doGetWindowTitle();

		if (this.properties.prefix) {
			title = `${this.properties.prefix} ${title || this.productService.nameLong}`;
		}

		if (this.properties.isAdmin) {
			title = `${title || this.productService.nameLong} ${TitlebarPart.NLS_USER_IS_ADMIN}`;
		}

		if (!this.properties.isPure) {
			title = `${title || this.productService.nameLong} ${TitlebarPart.NLS_UNSUPPORTED}`;
		}

		if (this.environmentService.isExtensionDevelopment) {
			title = `${TitlebarPart.NLS_EXTENSION_HOST} - ${title || this.productService.nameLong}`;
		}

		// Replace non-space whitespace
		title = title.replace(/[^\S ]/g, ' ');

		return title;
	}

	updateProperties(properties: ITitleProperties): void {
		const isAdmin = typeof properties.isAdmin === 'boolean' ? properties.isAdmin : this.properties.isAdmin;
		const isPure = typeof properties.isPure === 'boolean' ? properties.isPure : this.properties.isPure;
		const prefix = typeof properties.prefix === 'string' ? properties.prefix : this.properties.prefix;

		if (isAdmin !== this.properties.isAdmin || isPure !== this.properties.isPure || prefix !== this.properties.prefix) {
			this.properties.isAdmin = isAdmin;
			this.properties.isPure = isPure;
			this.properties.prefix = prefix;

			this.titleUpdater.schedule();
		}
	}

	/**
	 * Possible template values:
	 *
	 * {activeEditorLong}: e.g. /Users/Development/myFolder/myFileFolder/myFile.txt
	 * {activeEditorMedium}: e.g. myFolder/myFileFolder/myFile.txt
	 * {activeEditorShort}: e.g. myFile.txt
	 * {activeFolderLong}: e.g. /Users/Development/myFolder/myFileFolder
	 * {activeFolderMedium}: e.g. myFolder/myFileFolder
	 * {activeFolderShort}: e.g. myFileFolder
	 * {rootName}: e.g. myFolder1, myFolder2, myFolder3
	 * {rootPath}: e.g. /Users/Development
	 * {folderName}: e.g. myFolder
	 * {folderPath}: e.g. /Users/Development/myFolder
	 * {appName}: e.g. VS Code
	 * {remoteName}: e.g. SSH
	 * {dirty}: indicator
	 * {separator}: conditional separator
	 */
	private doGetWindowTitle(): string {
		const editor = this.editorService.activeEditor;
		const workspace = this.contextService.getWorkspace();

		// Compute root
		let root: URI | undefined;
		if (workspace.configuration) {
			root = workspace.configuration;
		} else if (workspace.folders.length) {
			root = workspace.folders[0].uri;
		}

		// Compute active editor folder
		const editorResource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
		let editorFolderResource = editorResource ? dirname(editorResource) : undefined;
		if (editorFolderResource?.path === '.') {
			editorFolderResource = undefined;
		}

		// Compute folder resource
		// Single Root Workspace: always the root single workspace in this case
		// Otherwise: root folder of the currently active file if any
		let folder: IWorkspaceFolder | undefined = undefined;
		if (this.contextService.getWorkbenchState() === WorkbenchState.FOLDER) {
			folder = workspace.folders[0];
		} else if (editorResource) {
			folder = withNullAsUndefined(this.contextService.getWorkspaceFolder(editorResource));
		}

		// Compute remote
		// vscode-remtoe: use as is
		// otherwise figure out if we have a virtual folder opened
		let remoteName: string | undefined = undefined;
		if (this.environmentService.remoteAuthority && !isWeb) {
			remoteName = this.labelService.getHostLabel(Schemas.vscodeRemote, this.environmentService.remoteAuthority);
		} else {
			const virtualWorkspaceLocation = getVirtualWorkspaceLocation(workspace);
			if (virtualWorkspaceLocation) {
				remoteName = this.labelService.getHostLabel(virtualWorkspaceLocation.scheme, virtualWorkspaceLocation.authority);
			}
		}

		// Variables
		const activeEditorShort = editor ? editor.getTitle(Verbosity.SHORT) : '';
		const activeEditorMedium = editor ? editor.getTitle(Verbosity.MEDIUM) : activeEditorShort;
		const activeEditorLong = editor ? editor.getTitle(Verbosity.LONG) : activeEditorMedium;
		const activeFolderShort = editorFolderResource ? basename(editorFolderResource) : '';
		const activeFolderMedium = editorFolderResource ? this.labelService.getUriLabel(editorFolderResource, { relative: true }) : '';
		const activeFolderLong = editorFolderResource ? this.labelService.getUriLabel(editorFolderResource) : '';
		const rootName = this.labelService.getWorkspaceLabel(workspace);
		const rootPath = root ? this.labelService.getUriLabel(root) : '';
		const folderName = folder ? folder.name : '';
		const folderPath = folder ? this.labelService.getUriLabel(folder.uri) : '';
		const dirty = editor?.isDirty() && !editor.isSaving() ? TitlebarPart.TITLE_DIRTY : '';
		const appName = this.productService.nameLong;
		const separator = this.configurationService.getValue<string>('window.titleSeparator');
		const titleTemplate = this.configurationService.getValue<string>('window.title');

		return template(titleTemplate, {
			activeEditorShort,
			activeEditorLong,
			activeEditorMedium,
			activeFolderShort,
			activeFolderMedium,
			activeFolderLong,
			rootName,
			rootPath,
			folderName,
			folderPath,
			dirty,
			appName,
			remoteName,
			separator: { label: separator }
		});
	}

	private uninstallMenubar(): void {
		if (this.customMenubar) {
			this.customMenubar.dispose();
			this.customMenubar = undefined;
		}

		if (this.menubar) {
			this.menubar.remove();
			this.menubar = undefined;
		}
	}

	protected installMenubar(): void {
		// If the menubar is already installed, skip
		if (this.menubar) {
			return;
		}

		this.customMenubar = this._register(this.instantiationService.createInstance(CustomMenubarControl));

		this.menubar = this.rootContainer.insertBefore($('div.menubar'), this.titleMenuElement);
		this.menubar.setAttribute('role', 'menubar');

		this.customMenubar.create(this.menubar);

		this._register(this.customMenubar.onVisibilityChange(e => this.onMenubarVisibilityChanged(e)));
	}

	private updateTitleMenu(): void {
		this.titleMenuDisposables.clear();
		const enableTitleMenu = this.configurationService.getValue<boolean>('window.experimental.titleMenu');
		this.rootContainer.classList.toggle('enable-title-menu', enableTitleMenu);
		if (!enableTitleMenu) {
			return;
		}


		const that = this;
		const titleToolbar = new ToolBar(this.titleMenuElement, this.contextMenuService, {
			actionViewItemProvider: (action) => {

				if (action instanceof SubmenuItemAction && action.item.submenu === MenuId.TitleMenuQuickPick) {
					class QuickInputDropDown extends DropdownWithDefaultActionViewItem {
						override render(container: HTMLElement): void {
							super.render(container);
							container.classList.add('quickopen');
							container.title = that.getWindowTitle();
							this._store.add(that.onDidUpdateTitle.event(() => container.title = that.getWindowTitle()));
						}
					}
					return that.instantiationService.createInstance(QuickInputDropDown, action, {
						keybindingProvider: action => that.keybindingService.lookupKeybinding(action.id),
						renderKeybindingWithDefaultActionLabel: true
					});
				}
				return undefined;
			}
		});
		const titleMenu = this.titleMenuDisposables.add(this.menuService.createMenu(MenuId.TitleMenu, this.contextKeyService));
		const titleMenuDisposables = this.titleMenuDisposables.add(new DisposableStore());
		const updateTitleMenu = () => {
			titleMenuDisposables.clear();
			const actions: IAction[] = [];
			titleMenuDisposables.add(createAndFillInContextMenuActions(titleMenu, undefined, actions));
			titleToolbar.setActions(actions);
		};
		this.titleMenuDisposables.add(titleMenu.onDidChange(updateTitleMenu));
		this.titleMenuDisposables.add(this.keybindingService.onDidUpdateKeybindings(updateTitleMenu));
		this.titleMenuDisposables.add(toDisposable(() => clearNode(this.titleMenuElement)));
		updateTitleMenu();
	}

	override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.rootContainer = append(parent, $('.titlebar-container'));
		append(this.rootContainer, this.titleMenuElement);

		// App Icon (Native Windows/Linux and Web)
		if (!isMacintosh || isWeb) {
			this.appIcon = prepend(this.rootContainer, $('a.window-appicon'));

			// Web-only home indicator and menu
			if (isWeb) {
				const homeIndicator = this.environmentService.options?.homeIndicator;
				if (homeIndicator) {
					const icon: ThemeIcon = getIconRegistry().getIcon(homeIndicator.icon) ? { id: homeIndicator.icon } : Codicon.code;

					this.appIcon.setAttribute('href', homeIndicator.href);
					this.appIcon.classList.add(...ThemeIcon.asClassNameArray(icon));
					this.appIconBadge = document.createElement('div');
					this.appIconBadge.classList.add('home-bar-icon-badge');
					this.appIcon.appendChild(this.appIconBadge);
				}
			}
		}

		// Menubar: install a custom menu bar depending on configuration
		// and when not in activity bar
		if (this.titleBarStyle !== 'native'
			&& (!isMacintosh || isWeb)
			&& this.currentMenubarVisibility !== 'compact') {
			this.installMenubar();
		}

		// Title Menu
		this.updateTitleMenu();

		// Title
		this.title = append(this.rootContainer, $('div.window-title'));
		if (this.pendingTitle) {
			this.title.innerText = this.pendingTitle;
		} else {
			this.titleUpdater.schedule();
		}

		if (this.titleBarStyle !== 'native') {
			this.layoutControls = append(this.rootContainer, $('div.layout-controls-container'));
			this.layoutControls.classList.toggle('show-layout-control', this.layoutControlEnabled);

			this.layoutToolbar = new ToolBar(this.layoutControls, this.contextMenuService, {
				actionViewItemProvider: action => {
					return createActionViewItem(this.instantiationService, action);
				},
				allowContextMenu: true
			});

			this._register(addDisposableListener(this.layoutControls, EventType.CONTEXT_MENU, e => {
				EventHelper.stop(e);

				this.onLayoutControlContextMenu(e, this.layoutControls!);
			}));


			const menu = this._register(this.menuService.createMenu(MenuId.LayoutControlMenu, this.contextKeyService));
			const updateLayoutMenu = () => {
				if (!this.layoutToolbar) {
					return;
				}

				const actions: IAction[] = [];
				const toDispose = createAndFillInContextMenuActions(menu, undefined, { primary: [], secondary: actions });

				this.layoutToolbar.setActions(actions);

				toDispose.dispose();
			};

			menu.onDidChange(updateLayoutMenu);
			updateLayoutMenu();
		}

		this.windowControls = append(this.element, $('div.window-controls-container'));

		// Context menu on title
		[EventType.CONTEXT_MENU, EventType.MOUSE_DOWN].forEach(event => {
			this._register(addDisposableListener(this.title, event, e => {
				if (e.type === EventType.CONTEXT_MENU || e.metaKey) {
					EventHelper.stop(e);

					this.onContextMenu(e);
				}
			}));
		});

		// Since the title area is used to drag the window, we do not want to steal focus from the
		// currently active element. So we restore focus after a timeout back to where it was.
		this._register(addDisposableListener(this.element, EventType.MOUSE_DOWN, e => {
			if (e.target && this.menubar && isAncestor(e.target as HTMLElement, this.menubar)) {
				return;
			}

			if (e.target && this.layoutToolbar && isAncestor(e.target as HTMLElement, this.layoutToolbar.getElement())) {
				return;
			}

			if (e.target && isAncestor(e.target as HTMLElement, this.titleMenuElement)) {
				return;
			}

			const active = document.activeElement;
			setTimeout(() => {
				if (active instanceof HTMLElement) {
					active.focus();
				}
			}, 0 /* need a timeout because we are in capture phase */);
		}, true /* use capture to know the currently active element properly */));

		this.updateStyles();

		return this.element;
	}

	override updateStyles(): void {
		super.updateStyles();

		// Part container
		if (this.element) {
			if (this.isInactive) {
				this.element.classList.add('inactive');
			} else {
				this.element.classList.remove('inactive');
			}

			const titleBackground = this.getColor(this.isInactive ? TITLE_BAR_INACTIVE_BACKGROUND : TITLE_BAR_ACTIVE_BACKGROUND, (color, theme) => {
				// LCD Rendering Support: the title bar part is a defining its own GPU layer.
				// To benefit from LCD font rendering, we must ensure that we always set an
				// opaque background color. As such, we compute an opaque color given we know
				// the background color is the workbench background.
				return color.isOpaque() ? color : color.makeOpaque(WORKBENCH_BACKGROUND(theme));
			}) || '';
			this.element.style.backgroundColor = titleBackground;

			if (this.appIconBadge) {
				this.appIconBadge.style.backgroundColor = titleBackground;
			}

			if (titleBackground && Color.fromHex(titleBackground).isLighter()) {
				this.element.classList.add('light');
			} else {
				this.element.classList.remove('light');
			}

			const titleForeground = this.getColor(this.isInactive ? TITLE_BAR_INACTIVE_FOREGROUND : TITLE_BAR_ACTIVE_FOREGROUND);
			this.element.style.color = titleForeground || '';

			const titleBorder = this.getColor(TITLE_BAR_BORDER);
			this.element.style.borderBottom = titleBorder ? `1px solid ${titleBorder}` : '';
		}
	}

	private onContextMenu(e: MouseEvent): void {
		// Find target anchor
		const event = new StandardMouseEvent(e);
		const anchor = { x: event.posx, y: event.posy };

		// Fill in contributed actions
		const actions: IAction[] = [];
		const actionsDisposable = createAndFillInContextMenuActions(this.contextMenu, undefined, actions);

		// Show it
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			onHide: () => dispose(actionsDisposable)
		});
	}

	private onLayoutControlContextMenu(e: MouseEvent, el: HTMLElement): void {
		// Find target anchor
		const event = new StandardMouseEvent(e);
		const anchor = { x: event.posx, y: event.posy };

		const actions: IAction[] = [];
		actions.push(toAction({
			id: 'layoutControl.hide',
			label: localize('layoutControl.hide', "Hide Layout Control"),
			run: () => {
				this.configurationService.updateValue('workbench.layoutControl.enabled', false);
			}
		}));

		// Show it
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			domForShadowRoot: el
		});
	}

	protected adjustTitleMarginToCenter(): void {
		const base = isMacintosh ? (this.windowControls?.clientWidth ?? 0) : 0;
		const leftMarker = base + (this.appIcon?.clientWidth ?? 0) + (this.menubar?.clientWidth ?? 0) + 10;
		const rightMarker = base + this.rootContainer.clientWidth - (this.layoutControls?.clientWidth ?? 0) - 10;

		// Not enough space to center the titlebar within window,
		// Center between left and right controls
		if (leftMarker > (this.rootContainer.clientWidth + (this.windowControls?.clientWidth ?? 0) - this.title.clientWidth) / 2 ||
			rightMarker < (this.rootContainer.clientWidth + (this.windowControls?.clientWidth ?? 0) + this.title.clientWidth) / 2) {
			this.title.style.position = '';
			this.title.style.left = '';
			this.title.style.transform = '';
			return;
		}

		this.title.style.position = 'absolute';
		this.title.style.left = '50%';
		this.title.style.transform = 'translate(-50%, 0)';
	}

	protected get currentMenubarVisibility(): MenuBarVisibility {
		return getMenuBarVisibility(this.configurationService);
	}

	private get layoutControlEnabled(): boolean {
		return this.configurationService.getValue<boolean>('workbench.layoutControl.enabled');
	}

	updateLayout(dimension: Dimension): void {
		this.lastLayoutDimensions = dimension;

		if (getTitleBarStyle(this.configurationService) === 'custom') {
			// Prevent zooming behavior if any of the following conditions are met:
			// 1. Native macOS
			// 2. Menubar is hidden
			// 3. Shrinking below the window control size (zoom < 1)
			const zoomFactor = getZoomFactor();
			this.element.style.setProperty('--zoom-factor', zoomFactor.toString());
			this.rootContainer.classList.toggle('counter-zoom', zoomFactor < 1 || (!isWeb && isMacintosh) || this.currentMenubarVisibility === 'hidden');

			runAtThisOrScheduleAtNextAnimationFrame(() => this.adjustTitleMarginToCenter());

			if (this.customMenubar) {
				const menubarDimension = new Dimension(0, dimension.height);
				this.customMenubar.layout(menubarDimension);
			}
		}
	}

	override layout(width: number, height: number): void {
		this.updateLayout(new Dimension(width, height));

		super.layoutContents(width, height);
	}

	toJSON(): object {
		return {
			type: Parts.TITLEBAR_PART
		};
	}
}

registerThemingParticipant((theme, collector) => {
	const titlebarActiveFg = theme.getColor(TITLE_BAR_ACTIVE_FOREGROUND);
	if (titlebarActiveFg) {
		collector.addRule(`
		.monaco-workbench .part.titlebar .window-controls-container .window-icon {
			color: ${titlebarActiveFg};
		}
		`);
	}

	const titlebarInactiveFg = theme.getColor(TITLE_BAR_INACTIVE_FOREGROUND);
	if (titlebarInactiveFg) {
		collector.addRule(`
		.monaco-workbench .part.titlebar.inactive .window-controls-container .window-icon {
				color: ${titlebarInactiveFg};
			}
		`);
	}
});

MenuRegistry.appendMenuItem(MenuId.TitleMenu, {
	submenu: MenuId.TitleMenuQuickPick,
	title: localize('title', "Select Mode"),
	order: Number.MAX_SAFE_INTEGER
});
