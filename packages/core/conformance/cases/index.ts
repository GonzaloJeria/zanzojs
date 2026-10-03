import type { NeutralSchema, NeutralTuple } from '../model';

export type Feature =
  | 'direct'
  | 'union'
  | 'computed-userset'
  | 'tuple-to-userset'
  | 'nested-tuple-to-userset'
  | 'recursive-tuple-to-userset'
  | 'cyclic-data'
  | 'expiration'
  | 'multiple-subject-types'
  | 'userset-subjects'
  | 'wildcard'
  | 'intersection'
  | 'exclusion';

/** [object, permission, subject, expected] */
export type CheckAssertion = [object: string, permission: string, subject: string, expected: boolean];

export interface LookupAssertion {
  type: string;
  permission: string;
  subject: string;
  /** Sorted object ids */
  expected: string[];
}

export interface SubjectLookupAssertion {
  object: string;
  permission: string;
  subjectType: string;
  expected: { subjects: string[]; wildcard?: boolean; excluded?: string[] };
}

export interface ConformanceCase {
  name: string;
  features: Feature[];
  schema: NeutralSchema;
  tuples: NeutralTuple[];
  checks: CheckAssertion[];
  lookups?: LookupAssertion[];
  subjectLookups?: SubjectLookupAssertion[];
}

const HOUR = 3_600_000;
const NOW = Date.now();

const workspaceModel: NeutralSchema = {
  User: {},
  Org: { relations: { admin: ['User'], member: ['User'] } },
  Workspace: {
    relations: { org: ['Org'], admin: ['User'] },
    permissions: { manage: 'admin | org->admin' },
  },
  Document: {
    relations: { workspace: ['Workspace'], owner: ['User'], editor: ['User'], viewer: ['User'] },
    permissions: {
      edit: 'owner | editor | workspace->manage',
      view: 'viewer | edit',
    },
  },
};

const workspaceTuples: NeutralTuple[] = [
  { object: 'Org:acme', relation: 'admin', subject: 'User:olivia' },
  { object: 'Workspace:eng', relation: 'org', subject: 'Org:acme' },
  { object: 'Workspace:eng', relation: 'admin', subject: 'User:walter' },
  { object: 'Workspace:sales', relation: 'org', subject: 'Org:acme' },
  { object: 'Document:spec', relation: 'workspace', subject: 'Workspace:eng' },
  { object: 'Document:spec', relation: 'owner', subject: 'User:alice' },
  { object: 'Document:spec', relation: 'viewer', subject: 'User:victor' },
  { object: 'Document:pitch', relation: 'workspace', subject: 'Workspace:sales' },
  { object: 'Document:pitch', relation: 'editor', subject: 'User:eve' },
];

export const conformanceCases: ConformanceCase[] = [
  {
    name: 'direct relation grants only its subject',
    features: ['direct'],
    schema: {
      User: {},
      Document: { relations: { owner: ['User'] }, permissions: { delete: 'owner' } },
    },
    tuples: [{ object: 'Document:1', relation: 'owner', subject: 'User:alice' }],
    checks: [
      ['Document:1', 'delete', 'User:alice', true],
      ['Document:1', 'delete', 'User:bob', false],
      ['Document:2', 'delete', 'User:alice', false],
    ],
  },
  {
    name: 'union of relations',
    features: ['direct', 'union'],
    schema: {
      User: {},
      Document: { relations: { owner: ['User'], viewer: ['User'] }, permissions: { view: 'owner | viewer' } },
    },
    tuples: [
      { object: 'Document:1', relation: 'owner', subject: 'User:alice' },
      { object: 'Document:1', relation: 'viewer', subject: 'User:bob' },
    ],
    checks: [
      ['Document:1', 'view', 'User:alice', true],
      ['Document:1', 'view', 'User:bob', true],
      ['Document:1', 'view', 'User:carol', false],
    ],
  },
  {
    name: 'permission referencing another permission (computed userset)',
    features: ['computed-userset', 'union'],
    schema: {
      User: {},
      Document: {
        relations: { owner: ['User'], editor: ['User'], viewer: ['User'] },
        permissions: { edit: 'owner | editor', view: 'viewer | edit' },
      },
    },
    tuples: [
      { object: 'Document:1', relation: 'owner', subject: 'User:alice' },
      { object: 'Document:1', relation: 'editor', subject: 'User:eve' },
      { object: 'Document:1', relation: 'viewer', subject: 'User:victor' },
    ],
    checks: [
      ['Document:1', 'view', 'User:alice', true],
      ['Document:1', 'view', 'User:eve', true],
      ['Document:1', 'view', 'User:victor', true],
      ['Document:1', 'edit', 'User:victor', false],
    ],
  },
  {
    name: 'inheritance from a parent relation (tuple to userset)',
    features: ['tuple-to-userset'],
    schema: {
      User: {},
      Workspace: { relations: { admin: ['User'] } },
      Document: { relations: { workspace: ['Workspace'] }, permissions: { view: 'workspace->admin' } },
    },
    tuples: [
      { object: 'Workspace:eng', relation: 'admin', subject: 'User:walter' },
      { object: 'Document:1', relation: 'workspace', subject: 'Workspace:eng' },
    ],
    checks: [
      ['Document:1', 'view', 'User:walter', true],
      ['Document:1', 'view', 'User:alice', false],
    ],
  },
  {
    name: 'inheritance through a parent permission across three levels',
    features: ['tuple-to-userset', 'nested-tuple-to-userset', 'computed-userset', 'union'],
    schema: workspaceModel,
    tuples: workspaceTuples,
    checks: [
      ['Document:spec', 'edit', 'User:alice', true],
      ['Document:spec', 'edit', 'User:walter', true],
      ['Document:spec', 'edit', 'User:olivia', true],
      ['Document:pitch', 'edit', 'User:olivia', true],
      ['Document:pitch', 'edit', 'User:walter', false],
      ['Document:spec', 'view', 'User:victor', true],
      ['Document:spec', 'edit', 'User:victor', false],
      ['Document:pitch', 'view', 'User:eve', true],
      ['Workspace:sales', 'manage', 'User:olivia', true],
      ['Workspace:sales', 'manage', 'User:walter', false],
    ],
    lookups: [
      { type: 'Document', permission: 'edit', subject: 'User:olivia', expected: ['Document:pitch', 'Document:spec'] },
      { type: 'Document', permission: 'edit', subject: 'User:walter', expected: ['Document:spec'] },
      { type: 'Document', permission: 'view', subject: 'User:victor', expected: ['Document:spec'] },
      { type: 'Document', permission: 'view', subject: 'User:nobody', expected: [] },
    ],
    subjectLookups: [
      { object: 'Document:spec', permission: 'edit', subjectType: 'User', expected: { subjects: ['User:alice', 'User:olivia', 'User:walter'] } },
      { object: 'Document:spec', permission: 'view', subjectType: 'User', expected: { subjects: ['User:alice', 'User:olivia', 'User:victor', 'User:walter'] } },
      { object: 'Document:pitch', permission: 'edit', subjectType: 'User', expected: { subjects: ['User:eve', 'User:olivia'] } },
    ],
  },
  {
    name: 'a resource with several parents (diamond)',
    features: ['tuple-to-userset'],
    schema: {
      User: {},
      Workspace: { relations: { admin: ['User'] } },
      Document: { relations: { workspace: ['Workspace'] }, permissions: { view: 'workspace->admin' } },
    },
    tuples: [
      { object: 'Workspace:a', relation: 'admin', subject: 'User:anna' },
      { object: 'Workspace:b', relation: 'admin', subject: 'User:ben' },
      { object: 'Document:shared', relation: 'workspace', subject: 'Workspace:a' },
      { object: 'Document:shared', relation: 'workspace', subject: 'Workspace:b' },
    ],
    checks: [
      ['Document:shared', 'view', 'User:anna', true],
      ['Document:shared', 'view', 'User:ben', true],
      ['Document:shared', 'view', 'User:carl', false],
    ],
  },
  {
    name: 'cyclic data with a non-recursive schema terminates',
    features: ['tuple-to-userset', 'cyclic-data'],
    schema: {
      User: {},
      Node: { relations: { parent: ['Node'], owner: ['User'] }, permissions: { read: 'owner | parent->owner' } },
    },
    tuples: [
      { object: 'Node:a', relation: 'parent', subject: 'Node:b' },
      { object: 'Node:b', relation: 'parent', subject: 'Node:a' },
      { object: 'Node:b', relation: 'owner', subject: 'User:bob' },
    ],
    checks: [
      ['Node:a', 'read', 'User:bob', true],
      ['Node:b', 'read', 'User:bob', true],
      ['Node:a', 'read', 'User:mallory', false],
    ],
  },
  {
    name: 'recursive inheritance through nested folders',
    features: ['tuple-to-userset', 'recursive-tuple-to-userset'],
    schema: {
      User: {},
      Folder: { relations: { parent: ['Folder'], viewer: ['User'] }, permissions: { view: 'viewer | parent->view' } },
    },
    tuples: [
      { object: 'Folder:root', relation: 'viewer', subject: 'User:alice' },
      { object: 'Folder:a', relation: 'parent', subject: 'Folder:root' },
      { object: 'Folder:b', relation: 'parent', subject: 'Folder:a' },
      { object: 'Folder:c', relation: 'parent', subject: 'Folder:b' },
      { object: 'Folder:b', relation: 'viewer', subject: 'User:bob' },
    ],
    checks: [
      ['Folder:c', 'view', 'User:alice', true],
      ['Folder:c', 'view', 'User:bob', true],
      ['Folder:a', 'view', 'User:bob', false],
    ],
    lookups: [{ type: 'Folder', permission: 'view', subject: 'User:bob', expected: ['Folder:b', 'Folder:c'] }],
    subjectLookups: [
      { object: 'Folder:c', permission: 'view', subjectType: 'User', expected: { subjects: ['User:alice', 'User:bob'] } },
      { object: 'Folder:a', permission: 'view', subjectType: 'User', expected: { subjects: ['User:alice'] } },
    ],
  },
  {
    name: 'recursive inheritance over cyclic data terminates',
    features: ['recursive-tuple-to-userset', 'cyclic-data'],
    schema: {
      User: {},
      Folder: { relations: { parent: ['Folder'], viewer: ['User'] }, permissions: { view: 'viewer | parent->view' } },
    },
    tuples: [
      { object: 'Folder:a', relation: 'parent', subject: 'Folder:b' },
      { object: 'Folder:b', relation: 'parent', subject: 'Folder:a' },
      { object: 'Folder:a', relation: 'viewer', subject: 'User:alice' },
    ],
    checks: [
      ['Folder:b', 'view', 'User:alice', true],
      ['Folder:b', 'view', 'User:mallory', false],
    ],
  },
  {
    name: 'expired tuples never grant, directly or through a parent',
    features: ['expiration', 'tuple-to-userset'],
    schema: {
      User: {},
      Workspace: { relations: { admin: ['User'] } },
      Document: {
        relations: { workspace: ['Workspace'], viewer: ['User'] },
        permissions: { view: 'viewer | workspace->admin' },
      },
    },
    tuples: [
      { object: 'Document:1', relation: 'viewer', subject: 'User:expired', expiresAt: NOW - HOUR },
      { object: 'Document:1', relation: 'viewer', subject: 'User:active', expiresAt: NOW + HOUR },
      { object: 'Workspace:w', relation: 'admin', subject: 'User:admin' },
      { object: 'Document:1', relation: 'workspace', subject: 'Workspace:w', expiresAt: NOW - HOUR },
      { object: 'Workspace:v', relation: 'admin', subject: 'User:expiredAdmin', expiresAt: NOW - HOUR },
      { object: 'Document:2', relation: 'workspace', subject: 'Workspace:v' },
    ],
    checks: [
      ['Document:1', 'view', 'User:expired', false],
      ['Document:1', 'view', 'User:active', true],
      ['Document:1', 'view', 'User:admin', false],
      ['Document:2', 'view', 'User:expiredAdmin', false],
    ],
    subjectLookups: [
      { object: 'Document:1', permission: 'view', subjectType: 'User', expected: { subjects: ['User:active'] } },
    ],
  },
  {
    name: 'a relation accepting several subject types',
    features: ['multiple-subject-types', 'tuple-to-userset'],
    schema: {
      User: {},
      Folder: { relations: { viewer: ['User'] }, permissions: { view: 'viewer' } },
      Workspace: { relations: { member: ['User'] }, permissions: { view: 'member' } },
      Document: { relations: { parent: ['Folder', 'Workspace'] }, permissions: { view: 'parent->view' } },
    },
    tuples: [
      { object: 'Folder:f', relation: 'viewer', subject: 'User:fiona' },
      { object: 'Workspace:w', relation: 'member', subject: 'User:will' },
      { object: 'Document:1', relation: 'parent', subject: 'Folder:f' },
      { object: 'Document:2', relation: 'parent', subject: 'Workspace:w' },
    ],
    checks: [
      ['Document:1', 'view', 'User:fiona', true],
      ['Document:2', 'view', 'User:will', true],
      ['Document:1', 'view', 'User:will', false],
    ],
  },
  {
    name: 'userset subjects and nested groups',
    features: ['userset-subjects'],
    schema: {
      User: {},
      Group: { relations: { member: ['User', 'Group#member'] } },
      Document: { relations: { viewer: ['User', 'Group#member'] }, permissions: { view: 'viewer' } },
    },
    tuples: [
      { object: 'Group:eng', relation: 'member', subject: 'User:alice' },
      { object: 'Group:backend', relation: 'member', subject: 'User:bob' },
      { object: 'Group:eng', relation: 'member', subject: 'Group:backend#member' },
      { object: 'Document:1', relation: 'viewer', subject: 'Group:eng#member' },
    ],
    checks: [
      ['Document:1', 'view', 'User:alice', true],
      ['Document:1', 'view', 'User:bob', true],
      ['Document:1', 'view', 'User:carol', false],
    ],
    lookups: [{ type: 'Document', permission: 'view', subject: 'User:bob', expected: ['Document:1'] }],
    subjectLookups: [
      { object: 'Document:1', permission: 'view', subjectType: 'User', expected: { subjects: ['User:alice', 'User:bob'] } },
    ],
  },
  {
    name: 'cyclic group membership terminates',
    features: ['userset-subjects', 'cyclic-data'],
    schema: {
      User: {},
      Group: { relations: { member: ['User', 'Group#member'] } },
      Document: { relations: { viewer: ['Group#member'] }, permissions: { view: 'viewer' } },
    },
    tuples: [
      { object: 'Group:a', relation: 'member', subject: 'Group:b#member' },
      { object: 'Group:b', relation: 'member', subject: 'Group:a#member' },
      { object: 'Group:b', relation: 'member', subject: 'User:bea' },
      { object: 'Document:1', relation: 'viewer', subject: 'Group:a#member' },
    ],
    checks: [
      ['Document:1', 'view', 'User:bea', true],
      ['Document:1', 'view', 'User:mallory', false],
    ],
  },
  {
    name: 'public wildcard',
    features: ['wildcard'],
    schema: {
      User: {},
      Bot: {},
      Document: { relations: { viewer: ['User', 'User:*'] }, permissions: { view: 'viewer' } },
    },
    tuples: [
      { object: 'Document:public', relation: 'viewer', subject: 'User:*' },
      { object: 'Document:private', relation: 'viewer', subject: 'User:alice' },
    ],
    checks: [
      ['Document:public', 'view', 'User:anyone', true],
      ['Document:public', 'view', 'Bot:crawler', false],
      ['Document:private', 'view', 'User:anyone', false],
    ],
    subjectLookups: [
      { object: 'Document:public', permission: 'view', subjectType: 'User', expected: { subjects: [], wildcard: true } },
      { object: 'Document:private', permission: 'view', subjectType: 'User', expected: { subjects: ['User:alice'] } },
      { object: 'Document:public', permission: 'view', subjectType: 'Bot', expected: { subjects: [] } },
    ],
  },
  {
    name: 'intersection requires every branch',
    features: ['intersection', 'tuple-to-userset'],
    schema: {
      User: {},
      Org: { relations: { member: ['User'] } },
      Document: {
        relations: { org: ['Org'], viewer: ['User'] },
        permissions: { view: 'viewer & org->member' },
      },
    },
    tuples: [
      { object: 'Org:acme', relation: 'member', subject: 'User:alice' },
      { object: 'Document:1', relation: 'org', subject: 'Org:acme' },
      { object: 'Document:1', relation: 'viewer', subject: 'User:alice' },
      { object: 'Document:1', relation: 'viewer', subject: 'User:contractor' },
    ],
    checks: [
      ['Document:1', 'view', 'User:alice', true],
      ['Document:1', 'view', 'User:contractor', false],
    ],
  },
  {
    name: 'exclusion removes subjects',
    features: ['exclusion', 'union'],
    schema: {
      User: {},
      Document: {
        relations: { viewer: ['User'], owner: ['User'], banned: ['User'] },
        permissions: { view: '(viewer | owner) - banned' },
      },
    },
    tuples: [
      { object: 'Document:1', relation: 'viewer', subject: 'User:alice' },
      { object: 'Document:1', relation: 'viewer', subject: 'User:mallory' },
      { object: 'Document:1', relation: 'banned', subject: 'User:mallory' },
    ],
    checks: [
      ['Document:1', 'view', 'User:alice', true],
      ['Document:1', 'view', 'User:mallory', false],
    ],
    subjectLookups: [
      { object: 'Document:1', permission: 'view', subjectType: 'User', expected: { subjects: ['User:alice'] } },
    ],
  },
  {
    name: 'public wildcard minus banned subjects',
    features: ['wildcard', 'exclusion'],
    schema: {
      User: {},
      Document: { relations: { viewer: ['User:*'], banned: ['User'] }, permissions: { view: 'viewer - banned' } },
    },
    tuples: [
      { object: 'Document:1', relation: 'viewer', subject: 'User:*' },
      { object: 'Document:1', relation: 'banned', subject: 'User:mallory' },
    ],
    checks: [
      ['Document:1', 'view', 'User:anyone', true],
      ['Document:1', 'view', 'User:mallory', false],
    ],
    lookups: [{ type: 'Document', permission: 'view', subject: 'User:anyone', expected: ['Document:1'] }],
    subjectLookups: [
      { object: 'Document:1', permission: 'view', subjectType: 'User', expected: { subjects: [], wildcard: true, excluded: ['User:mallory'] } },
    ],
  },
];
