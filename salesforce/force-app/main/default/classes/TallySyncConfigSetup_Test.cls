@isTest
private class TallySyncConfigSetup_Test {

    private static List<TallySyncConfigSetup.ConfigItem> twoItems() {
        TallySyncConfigSetup.ConfigItem a = new TallySyncConfigSetup.ConfigItem();
        a.objectType = 'Invoice'; a.direction = 'Both'; a.enabled = true;
        TallySyncConfigSetup.ConfigItem b = new TallySyncConfigSetup.ConfigItem();
        b.objectType = 'Account'; b.direction = 'ToTally'; b.enabled = true;
        // A disabled item that must NOT create a row.
        TallySyncConfigSetup.ConfigItem c = new TallySyncConfigSetup.ConfigItem();
        c.objectType = 'Product'; c.direction = 'ToTally'; c.enabled = false;
        return new List<TallySyncConfigSetup.ConfigItem>{ a, b, c };
    }

    private static List<Account> makeAccounts() {
        List<Account> accts = new List<Account>{
            new Account(Name = 'Dist A', SAP_ID__c = 'SAPA-001'),
            new Account(Name = 'Dist B', SAP_ID__c = 'SAPB-002')
        };
        insert accts;
        return accts;
    }

    @isTest
    static void applyConfig_creates_then_updates_no_dupes() {
        List<Account> accts = makeAccounts();
        List<Id> ids = new List<Id>{ accts[0].Id, accts[1].Id };

        Test.startTest();
        String s1 = TallySyncConfigSetup.applyConfig(ids, twoItems(), 'Interval', 15, null);
        Test.stopTest();

        // 2 accounts x 2 enabled items = 4 rows (Product disabled -> skipped).
        List<Sync_Config__c> rows = [
            SELECT Account__c, Object_Type__c, Direction__c, Enabled__c, Schedule_Type__c, Frequency_Minutes__c
            FROM Sync_Config__c
        ];
        System.assertEquals(4, rows.size(), 'expected 4 rows (2 accts x 2 enabled items)');
        System.assert(s1.contains('Created 4'), 'summary should report 4 created: ' + s1);
        for (Sync_Config__c sc : rows) {
            System.assertEquals('Interval', sc.Schedule_Type__c);
            System.assertEquals(15, sc.Frequency_Minutes__c);
            System.assertEquals(true, sc.Enabled__c);
            System.assert(sc.Object_Type__c == 'Invoice' || sc.Object_Type__c == 'Account');
        }

        // Re-run: must UPDATE the same rows, not duplicate.
        String s2 = TallySyncConfigSetup.applyConfig(ids, twoItems(), 'Interval', 30, null);
        List<Sync_Config__c> rows2 = [SELECT Id, Frequency_Minutes__c FROM Sync_Config__c];
        System.assertEquals(4, rows2.size(), 'still 4 rows after re-run (idempotent)');
        System.assert(s2.contains('updated 4'), 'summary should report 4 updated: ' + s2);
        for (Sync_Config__c sc : rows2) System.assertEquals(30, sc.Frequency_Minutes__c, 'frequency updated on re-run');
    }

    @isTest
    static void applyConfig_daily_schedule() {
        List<Account> accts = makeAccounts();
        TallySyncConfigSetup.ConfigItem a = new TallySyncConfigSetup.ConfigItem();
        a.objectType = 'Invoice'; a.direction = 'ToSalesforce'; a.enabled = true;
        TallySyncConfigSetup.applyConfig(new List<Id>{ accts[0].Id },
            new List<TallySyncConfigSetup.ConfigItem>{ a }, 'Daily', null, '09:30');
        Sync_Config__c sc = [SELECT Schedule_Type__c, Daily_Time__c, Frequency_Minutes__c FROM Sync_Config__c LIMIT 1];
        System.assertEquals('Daily', sc.Schedule_Type__c);
        System.assertEquals('09:30', sc.Daily_Time__c);
        System.assertEquals(null, sc.Frequency_Minutes__c, 'daily schedule clears frequency');
    }

    @isTest
    static void applyConfig_guards() {
        System.assertEquals('No accounts selected.',
            TallySyncConfigSetup.applyConfig(new List<Id>(), twoItems(), 'Interval', 15, null));
        List<Account> accts = makeAccounts();
        System.assertEquals('No object types included.',
            TallySyncConfigSetup.applyConfig(new List<Id>{ accts[0].Id },
                new List<TallySyncConfigSetup.ConfigItem>(), 'Interval', 15, null));
        // Items present but all disabled -> nothing included.
        TallySyncConfigSetup.ConfigItem off = new TallySyncConfigSetup.ConfigItem();
        off.objectType = 'Invoice'; off.direction = 'Both'; off.enabled = false;
        System.assertEquals('No object types included.',
            TallySyncConfigSetup.applyConfig(new List<Id>{ accts[0].Id },
                new List<TallySyncConfigSetup.ConfigItem>{ off }, 'Interval', 15, null));
    }

    @isTest
    static void listDistributors_counts_configs() {
        List<Account> accts = makeAccounts();
        // An Account WITHOUT a SAP Id must NOT appear.
        insert new Account(Name = 'Not a distributor');
        // Give account A two config rows.
        TallySyncConfigSetup.applyConfig(new List<Id>{ accts[0].Id }, twoItems(), 'Interval', 15, null);

        List<TallySyncConfigSetup.Distributor> dists = TallySyncConfigSetup.listDistributors();
        System.assertEquals(2, dists.size(), 'only SAP-Id accounts are distributors');
        Map<Id, Integer> byId = new Map<Id, Integer>();
        for (TallySyncConfigSetup.Distributor d : dists) byId.put(d.id, d.configCount);
        System.assertEquals(2, byId.get(accts[0].Id), 'Dist A has 2 config rows');
        System.assertEquals(0, byId.get(accts[1].Id), 'Dist B has none');
    }

    @isTest
    static void loadConfig_prefills_existing() {
        List<Account> accts = makeAccounts();
        TallySyncConfigSetup.applyConfig(new List<Id>{ accts[0].Id }, twoItems(), 'Interval', 20, null);

        TallySyncConfigSetup.ConfigBundle b = TallySyncConfigSetup.loadConfig(accts[0].Id);
        System.assertEquals(2, b.items.size(), 'two existing items loaded');
        System.assertEquals('Interval', b.scheduleType);
        System.assertEquals(20, b.frequencyMinutes);
        Set<String> objs = new Set<String>();
        for (TallySyncConfigSetup.ConfigItem it : b.items) objs.add(it.objectType);
        System.assert(objs.contains('Invoice') && objs.contains('Account'));

        // Null guard.
        TallySyncConfigSetup.ConfigBundle empty = TallySyncConfigSetup.loadConfig(null);
        System.assertEquals(0, empty.items.size());
    }
}
