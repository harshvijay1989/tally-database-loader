import { LightningElement, track, wire } from 'lwc';
import { refreshApex } from '@salesforce/apex';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import listDistributors from '@salesforce/apex/TallySyncConfigSetup.listDistributors';
import loadConfig from '@salesforce/apex/TallySyncConfigSetup.loadConfig';
import applyConfig from '@salesforce/apex/TallySyncConfigSetup.applyConfig';

const DIRECTION_OPTIONS = [
    { label: 'To Tally', value: 'ToTally' },
    { label: 'To Salesforce', value: 'ToSalesforce' },
    { label: 'Both', value: 'Both' }
];

const SCHEDULE_OPTIONS = [
    { label: 'Interval', value: 'Interval' },
    { label: 'Daily', value: 'Daily' }
];

// Object types + sensible default direction. include defaults to true.
const DEFAULT_MATRIX = [
    { objectType: 'Invoice', direction: 'Both' },
    { objectType: 'Purchase', direction: 'Both' },
    { objectType: 'Order', direction: 'Both' },
    { objectType: 'Note', direction: 'Both' },
    { objectType: 'PurchaseOrder', direction: 'ToTally' },
    { objectType: 'Account', direction: 'Both' },
    { objectType: 'Product', direction: 'ToTally' },
    { objectType: 'Warehouse', direction: 'Both' },
    { objectType: 'Price', direction: 'ToTally' }
];

const DIST_COLUMNS = [
    { label: 'Distributor', fieldName: 'name' },
    { label: 'SAP Id', fieldName: 'sapId' },
    { label: 'Sync configured', fieldName: 'configLabel', type: 'text',
      cellAttributes: { alignment: 'center' } }
];

const STATUS_OPTIONS = [
    { label: 'All', value: 'all' },
    { label: 'Already configured', value: 'configured' },
    { label: 'Not configured yet', value: 'new' }
];

export default class TallySyncConfigSetup extends LightningElement {
    distColumns = DIST_COLUMNS;
    directionOptions = DIRECTION_OPTIONS;
    scheduleOptions = SCHEDULE_OPTIONS;
    statusOptions = STATUS_OPTIONS;

    @track distributors = [];
    @track matrix = this.freshMatrix();

    // Persistent selection across filtering/search: ids survive filter/search changes.
    @track selectedIds = new Set();

    searchTerm = '';
    statusFilter = 'all';
    scheduleType = 'Interval';
    frequencyMinutes = 15;
    dailyTime = '09:00';
    applying = false;
    wiredResult;

    freshMatrix() {
        return DEFAULT_MATRIX.map(r => ({ ...r, include: true }));
    }

    @wire(listDistributors)
    wiredDistributors(result) {
        this.wiredResult = result;
        if (result.data) {
            this.distributors = result.data.map(d => ({
                ...d,
                configLabel: d.configCount > 0 ? `Yes (${d.configCount})` : 'Not yet'
            }));
        }
    }

    get isInterval() { return this.scheduleType === 'Interval'; }
    get isDaily() { return this.scheduleType === 'Daily'; }

    // Rows to show = status filter AND case-insensitive "contains" on Name or SAP Id.
    get filteredDistributors() {
        const term = (this.searchTerm || '').trim().toLowerCase();
        return this.distributors.filter(d => {
            if (this.statusFilter === 'configured' && !(d.configCount > 0)) return false;
            if (this.statusFilter === 'new' && d.configCount > 0) return false;
            if (!term) return true;
            const name = (d.name || '').toLowerCase();
            const sap = (d.sapId || '').toLowerCase();
            return name.includes(term) || sap.includes(term);
        });
    }

    // Selected ids currently visible — what the datatable's selected-rows must reflect so a
    // selection made under one filter re-appears when it comes back into view.
    get visibleSelectedIds() {
        return this.filteredDistributors.filter(d => this.selectedIds.has(d.id)).map(d => d.id);
    }

    get selectedCount() { return this.selectedIds.size; }
    get totalCount() { return this.distributors.length; }
    get shownCount() { return this.filteredDistributors.length; }

    get includedCount() { return this.matrix.filter(r => r.include).length; }

    get applyDisabled() {
        return this.applying || this.selectedIds.size === 0 || this.includedCount === 0;
    }

    // "Load existing config" only makes sense for exactly one selected, already-configured distributor.
    get loadDisabled() {
        if (this.selectedIds.size !== 1) return true;
        const only = [...this.selectedIds][0];
        const d = this.distributors.find(x => x.id === only);
        return !d || !d.configCount || d.configCount === 0;
    }

    handleSearch(event) { this.searchTerm = event.target.value; }
    handleStatusFilter(event) { this.statusFilter = event.detail.value; }

    // Merge the datatable's selection against the Set: only the CURRENTLY VISIBLE rows can change
    // here, so re-derive their selected state and leave off-view selections intact.
    handleRowSelection(event) {
        const nowSelected = new Set(event.detail.selectedRows.map(r => r.id));
        const next = new Set(this.selectedIds);
        for (const d of this.filteredDistributors) {
            if (nowSelected.has(d.id)) next.add(d.id);
            else next.delete(d.id);
        }
        this.selectedIds = next; // reassign to trigger reactivity
    }

    handleInclude(event) {
        const i = Number(event.target.dataset.index);
        const m = [...this.matrix];
        m[i] = { ...m[i], include: event.target.checked };
        this.matrix = m;
    }

    handleDirection(event) {
        const i = Number(event.target.dataset.index);
        const m = [...this.matrix];
        m[i] = { ...m[i], direction: event.detail.value };
        this.matrix = m;
    }

    handleScheduleType(event) { this.scheduleType = event.detail.value; }
    handleFrequency(event) { this.frequencyMinutes = event.target.value; }
    handleDailyTime(event) { this.dailyTime = event.target.value; }

    async handleLoadExisting() {
        if (this.loadDisabled) return;
        try {
            const bundle = await loadConfig({ accountId: [...this.selectedIds][0] });
            const byObj = {};
            (bundle.items || []).forEach(it => { byObj[it.objectType] = it; });
            // Start from defaults, then overlay the existing rows: included where a row exists.
            this.matrix = DEFAULT_MATRIX.map(r => {
                const ex = byObj[r.objectType];
                return ex
                    ? { objectType: r.objectType, direction: ex.direction || r.direction, include: true }
                    : { ...r, include: false };
            });
            if (bundle.scheduleType) this.scheduleType = bundle.scheduleType;
            if (bundle.frequencyMinutes != null) this.frequencyMinutes = bundle.frequencyMinutes;
            if (bundle.dailyTime) this.dailyTime = bundle.dailyTime;
            this.toast('Loaded', 'Pre-filled from this distributor\'s existing config.', 'success');
        } catch (e) {
            this.toast('Could not load config', this.errMsg(e), 'error');
        }
    }

    async handleApply() {
        if (this.applyDisabled) return;
        this.applying = true;
        const items = this.matrix.map(r => ({
            objectType: r.objectType, direction: r.direction, enabled: r.include
        }));
        try {
            const summary = await applyConfig({
                accountIds: [...this.selectedIds],
                items,
                scheduleType: this.scheduleType,
                frequencyMinutes: this.isInterval ? this.frequencyMinutes : null,
                dailyTime: this.isDaily ? this.dailyTime : null
            });
            this.toast('Sync Config applied', summary, 'success');
            // Refresh the distributor counts so the status column reflects the new rows.
            if (this.wiredResult) await refreshApex(this.wiredResult);
        } catch (e) {
            this.toast('Apply failed', this.errMsg(e), 'error');
        } finally {
            this.applying = false;
        }
    }

    errMsg(e) {
        return (e && e.body && e.body.message) ? e.body.message : (e && e.message) ? e.message : 'Unknown error';
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
