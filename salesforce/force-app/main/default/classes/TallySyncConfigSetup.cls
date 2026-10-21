/**
 * Controller for the Tally Sync Config generator screen (LWC: tallySyncConfigSetup).
 * Bulk-creates / updates Sync_Config__c rows (one per Account x Object_Type) without
 * changing the data model — the connector reads the same rows unchanged.
 */
public with sharing class TallySyncConfigSetup {

    /** A distributor Account + how many Sync_Config rows it already has. */
    public class Distributor {
        @AuraEnabled public Id id { get; set; }
        @AuraEnabled public String name { get; set; }
        @AuraEnabled public String sapId { get; set; }
        @AuraEnabled public Integer configCount { get; set; }
    }

    /** One object-type row from the screen's matrix / an existing config row. */
    public class ConfigItem {
        @AuraEnabled public String objectType { get; set; }
        @AuraEnabled public String direction { get; set; }
        @AuraEnabled public Boolean enabled { get; set; }
    }

    /** An account's existing config: its object-type items + the shared schedule. */
    public class ConfigBundle {
        @AuraEnabled public List<ConfigItem> items { get; set; }
        @AuraEnabled public String scheduleType { get; set; }
        @AuraEnabled public Decimal frequencyMinutes { get; set; }
        @AuraEnabled public String dailyTime { get; set; }
    }

    /** Distributors = Accounts with a SAP Id, each annotated with its Sync_Config row count. */
    @AuraEnabled(cacheable=true)
    public static List<Distributor> listDistributors() {
        // ONE aggregate query for the counts, keyed by Account.
        Map<Id, Integer> counts = new Map<Id, Integer>();
        for (AggregateResult ar : [
            SELECT Account__c acc, COUNT(Id) cnt
            FROM Sync_Config__c
            WHERE Account__c != null
            GROUP BY Account__c
        ]) {
            counts.put((Id) ar.get('acc'), (Integer) ar.get('cnt'));
        }
        List<Distributor> out = new List<Distributor>();
        for (Account a : [SELECT Id, Name, SAP_ID__c FROM Account WHERE SAP_ID__c != null ORDER BY Name]) {
            Distributor d = new Distributor();
            d.id = a.Id;
            d.name = a.Name;
            d.sapId = a.SAP_ID__c;
            d.configCount = counts.containsKey(a.Id) ? counts.get(a.Id) : 0;
            out.add(d);
        }
        return out;
    }

    /** Load one distributor's EXISTING config so the screen can pre-fill (review + re-apply). */
    @AuraEnabled
    public static ConfigBundle loadConfig(Id accountId) {
        ConfigBundle bundle = new ConfigBundle();
        bundle.items = new List<ConfigItem>();
        if (accountId == null) return bundle;

        Map<String, Integer> schedVotes = new Map<String, Integer>();
        Map<String, Decimal> freqByObj = new Map<String, Decimal>();
        for (Sync_Config__c sc : [
            SELECT Object_Type__c, Direction__c, Enabled__c, Schedule_Type__c, Frequency_Minutes__c, Daily_Time__c
            FROM Sync_Config__c
            WHERE Account__c = :accountId
            ORDER BY Object_Type__c
        ]) {
            ConfigItem it = new ConfigItem();
            it.objectType = sc.Object_Type__c;
            it.direction = sc.Direction__c;
            it.enabled = sc.Enabled__c;
            bundle.items.add(it);
            // Rows share one schedule in practice — take the most common, and the first non-null
            // frequency/time seen for it.
            String st = String.isBlank(sc.Schedule_Type__c) ? 'Interval' : sc.Schedule_Type__c;
            schedVotes.put(st, (schedVotes.containsKey(st) ? schedVotes.get(st) : 0) + 1);
            if (bundle.frequencyMinutes == null && sc.Frequency_Minutes__c != null) bundle.frequencyMinutes = sc.Frequency_Minutes__c;
            if (String.isBlank(bundle.dailyTime) && String.isNotBlank(sc.Daily_Time__c)) bundle.dailyTime = sc.Daily_Time__c;
        }
        // Pick the most-common schedule type (default Interval).
        String best = 'Interval'; Integer bestN = -1;
        for (String st : schedVotes.keySet()) { if (schedVotes.get(st) > bestN) { bestN = schedVotes.get(st); best = st; } }
        bundle.scheduleType = best;
        return bundle;
    }

    /**
     * Create/update Sync_Config__c rows for every selected account x included item.
     * Idempotent: an existing row for the same Account x Object_Type is updated, never duplicated.
     * Rows for object types the admin did not include are left untouched.
     */
    @AuraEnabled
    public static String applyConfig(List<Id> accountIds, List<ConfigItem> items,
                                     String scheduleType, Decimal frequencyMinutes, String dailyTime) {
        if (accountIds == null || accountIds.isEmpty()) return 'No accounts selected.';
        if (items == null || items.isEmpty()) return 'No object types included.';

        // Only the included+enabled items matter.
        List<ConfigItem> active = new List<ConfigItem>();
        for (ConfigItem it : items) {
            if (it != null && it.enabled == true && String.isNotBlank(it.objectType)) active.add(it);
        }
        if (active.isEmpty()) return 'No object types included.';

        Boolean isDaily = 'Daily'.equalsIgnoreCase(scheduleType);
        String schedule = isDaily ? 'Daily' : 'Interval';
        Decimal freq = isDaily ? null : (frequencyMinutes == null ? 15 : frequencyMinutes);
        String dTime = isDaily ? dailyTime : null;

        // One SOQL: existing rows for these accounts, keyed by Account|ObjectType.
        Map<String, Sync_Config__c> existing = new Map<String, Sync_Config__c>();
        for (Sync_Config__c sc : [
            SELECT Id, Account__c, Object_Type__c, Direction__c, Enabled__c,
                   Schedule_Type__c, Frequency_Minutes__c, Daily_Time__c
            FROM Sync_Config__c
            WHERE Account__c IN :accountIds
        ]) {
            existing.put(sc.Account__c + '|' + sc.Object_Type__c, sc);
        }

        List<Sync_Config__c> toUpsert = new List<Sync_Config__c>();
        Integer created = 0, updated = 0;
        for (Id accId : accountIds) {
            if (accId == null) continue;
            for (ConfigItem it : active) {
                String key = accId + '|' + it.objectType;
                Sync_Config__c sc = existing.get(key);
                if (sc == null) {
                    sc = new Sync_Config__c(Account__c = accId, Object_Type__c = it.objectType);
                    created++;
                } else {
                    updated++;
                }
                sc.Direction__c = String.isBlank(it.direction) ? 'Both' : it.direction;
                sc.Enabled__c = true;
                sc.Schedule_Type__c = schedule;
                sc.Frequency_Minutes__c = freq;
                sc.Daily_Time__c = dTime;
                toUpsert.add(sc);
            }
        }

        if (!toUpsert.isEmpty()) upsert toUpsert;
        return 'Created ' + created + ', updated ' + updated + ' Sync Config rows across ' + accountIds.size() + ' accounts.';
    }
}
