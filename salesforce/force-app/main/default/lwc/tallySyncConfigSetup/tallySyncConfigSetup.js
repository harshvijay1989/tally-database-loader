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
    { objectType: 'Godown', direction: 'Both' }
];

const DIST_COLUMNS = [
    { label: 'Distributor', fieldName: 'name' },
    { label: 'SAP Id', fieldName: 'sapId' },
    { label: 'Sync configured', fieldName: 'configLabel', type: 'text',
      cellAttributes: { alignment: 'center' } }
];

export default class TallySyncConfigSetup extends LightningElement {
    distColumns = DIST_COLUMNS;
    directionOptions = DIRECTION_OPTIONS;
    scheduleOptions = SCHEDULE_OPTIONS;

    @track distributors = [];
    @track selectedRows = [];        // selected account ids
    @track matrix = this.freshMatrix();

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
                configLabel: d.configCount > 0 ? `Yes (${d.configCount})` : 'No'
            }));
        }
    }

    get isInterval() { return this.scheduleType === 'Interval'; }
    get isDaily() { return this.scheduleType === 'Daily'; }

    get selectedCount() { return this.selectedRows.length; }

    get includedCount() { return this.matrix.filter(r => r.include).length; }

    get applyDisabled() {
        return this.applying || this.selectedRows.length === 0 || this.includedCount === 0;
    }

    // "Load existing config" only makes sense for exactly one selected, already-configured distributor.
    get loadDisabled() {
        if (this.selectedRows.length !== 1) return true;
        const d = this.distributors.find(x => x.id === this.selectedRows[0]);
        return !d || !d.configCount || d.configCount === 0;
    }

    handleRowSelection(event) {
        this.selectedRows = event.detail.selectedRows.map(r => r.id);
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
            const bundle = await loadConfig({ accountId: this.selectedRows[0] });
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
                accountIds: this.selectedRows,
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
