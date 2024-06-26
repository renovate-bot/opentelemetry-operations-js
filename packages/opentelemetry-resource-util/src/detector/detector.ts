// Copyright 2022 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  CLOUDPLATFORMVALUES_GCP_APP_ENGINE,
  CLOUDPLATFORMVALUES_GCP_CLOUD_FUNCTIONS,
  CLOUDPLATFORMVALUES_GCP_CLOUD_RUN,
  CLOUDPLATFORMVALUES_GCP_COMPUTE_ENGINE,
  CLOUDPLATFORMVALUES_GCP_KUBERNETES_ENGINE,
  CLOUDPROVIDERVALUES_GCP,
  SEMRESATTRS_CLOUD_ACCOUNT_ID,
  SEMRESATTRS_CLOUD_AVAILABILITY_ZONE,
  SEMRESATTRS_CLOUD_PLATFORM,
  SEMRESATTRS_CLOUD_PROVIDER,
  SEMRESATTRS_CLOUD_REGION,
  SEMRESATTRS_FAAS_INSTANCE,
  SEMRESATTRS_FAAS_NAME,
  SEMRESATTRS_FAAS_VERSION,
  SEMRESATTRS_HOST_ID,
  SEMRESATTRS_HOST_NAME,
  SEMRESATTRS_HOST_TYPE,
  SEMRESATTRS_K8S_CLUSTER_NAME,
} from '@opentelemetry/semantic-conventions';

import {Attributes} from '@opentelemetry/api';
import {Detector, DetectorSync, Resource} from '@opentelemetry/resources';
import * as metadata from 'gcp-metadata';
import * as faas from './faas';
import * as gae from './gae';
import * as gce from './gce';
import * as gke from './gke';

async function detect(): Promise<Resource> {
  if (!(await metadata.isAvailable())) {
    return Resource.EMPTY;
  }

  // Note the order of these if checks is significant with more specific resources coming
  // first. E.g. Cloud Functions gen2 are executed in Cloud Run so it must be checked first.
  if (await gke.onGke()) {
    return await gkeResource();
  } else if (await faas.onCloudFunctions()) {
    return await cloudFunctionsResource();
  } else if (await faas.onCloudRun()) {
    return await cloudRunResource();
  } else if (await gae.onAppEngine()) {
    return await gaeResource();
  } else if (await gce.onGce()) {
    return await gceResource();
  }

  return Resource.EMPTY;
}

async function gkeResource(): Promise<Resource> {
  const [zoneOrRegion, k8sClusterName, hostId] = await Promise.all([
    gke.availabilityZoneOrRegion(),
    gke.clusterName(),
    gke.hostId(),
  ]);

  return await makeResource({
    [SEMRESATTRS_CLOUD_PLATFORM]: CLOUDPLATFORMVALUES_GCP_KUBERNETES_ENGINE,
    [zoneOrRegion.type === 'zone'
      ? SEMRESATTRS_CLOUD_AVAILABILITY_ZONE
      : SEMRESATTRS_CLOUD_REGION]: zoneOrRegion.value,
    [SEMRESATTRS_K8S_CLUSTER_NAME]: k8sClusterName,
    [SEMRESATTRS_HOST_ID]: hostId,
  });
}

async function cloudRunResource(): Promise<Resource> {
  const [faasName, faasVersion, faasInstance, faasCloudRegion] =
    await Promise.all([
      faas.faasName(),
      faas.faasVersion(),
      faas.faasInstance(),
      faas.faasCloudRegion(),
    ]);

  return await makeResource({
    [SEMRESATTRS_CLOUD_PLATFORM]: CLOUDPLATFORMVALUES_GCP_CLOUD_RUN,
    [SEMRESATTRS_FAAS_NAME]: faasName,
    [SEMRESATTRS_FAAS_VERSION]: faasVersion,
    [SEMRESATTRS_FAAS_INSTANCE]: faasInstance,
    [SEMRESATTRS_CLOUD_REGION]: faasCloudRegion,
  });
}

async function cloudFunctionsResource(): Promise<Resource> {
  const [faasName, faasVersion, faasInstance, faasCloudRegion] =
    await Promise.all([
      faas.faasName(),
      faas.faasVersion(),
      faas.faasInstance(),
      faas.faasCloudRegion(),
    ]);

  return await makeResource({
    [SEMRESATTRS_CLOUD_PLATFORM]: CLOUDPLATFORMVALUES_GCP_CLOUD_FUNCTIONS,
    [SEMRESATTRS_FAAS_NAME]: faasName,
    [SEMRESATTRS_FAAS_VERSION]: faasVersion,
    [SEMRESATTRS_FAAS_INSTANCE]: faasInstance,
    [SEMRESATTRS_CLOUD_REGION]: faasCloudRegion,
  });
}

async function gaeResource(): Promise<Resource> {
  let zone, region;
  if (await gae.onAppEngineStandard()) {
    [zone, region] = await Promise.all([
      gae.standardAvailabilityZone(),
      gae.standardCloudRegion(),
    ]);
  } else {
    ({zone, region} = await gce.availabilityZoneAndRegion());
  }
  const [faasName, faasVersion, faasInstance] = await Promise.all([
    gae.serviceName(),
    gae.serviceVersion(),
    gae.serviceInstance(),
  ]);

  return await makeResource({
    [SEMRESATTRS_CLOUD_PLATFORM]: CLOUDPLATFORMVALUES_GCP_APP_ENGINE,
    [SEMRESATTRS_FAAS_NAME]: faasName,
    [SEMRESATTRS_FAAS_VERSION]: faasVersion,
    [SEMRESATTRS_FAAS_INSTANCE]: faasInstance,
    [SEMRESATTRS_CLOUD_AVAILABILITY_ZONE]: zone,
    [SEMRESATTRS_CLOUD_REGION]: region,
  });
}

async function gceResource(): Promise<Resource> {
  const [zoneAndRegion, hostType, hostId, hostName] = await Promise.all([
    gce.availabilityZoneAndRegion(),
    gce.hostType(),
    gce.hostId(),
    gce.hostName(),
  ]);

  return await makeResource({
    [SEMRESATTRS_CLOUD_PLATFORM]: CLOUDPLATFORMVALUES_GCP_COMPUTE_ENGINE,
    [SEMRESATTRS_CLOUD_AVAILABILITY_ZONE]: zoneAndRegion.zone,
    [SEMRESATTRS_CLOUD_REGION]: zoneAndRegion.region,
    [SEMRESATTRS_HOST_TYPE]: hostType,
    [SEMRESATTRS_HOST_ID]: hostId,
    [SEMRESATTRS_HOST_NAME]: hostName,
  });
}

async function makeResource(attrs: Attributes): Promise<Resource> {
  const project = await metadata.project<string>('project-id');

  return new Resource({
    [SEMRESATTRS_CLOUD_PROVIDER]: CLOUDPROVIDERVALUES_GCP,
    [SEMRESATTRS_CLOUD_ACCOUNT_ID]: project,
    ...attrs,
  });
}

/**
 * Async Google Cloud resource detector which populates attributes based the on environment
 * this process is running in. If not on GCP, returns an empty resource.
 *
 * @deprecated Async resource detectors are deprecated. Please use {@link GcpDetectorSync} instead.
 */
export class GcpDetector implements Detector {
  detect = detect;
}

/**
 * Google Cloud resource detector which populates attributes based on the environment this
 * process is running in. If not on GCP, returns an empty resource.
 */
export class GcpDetectorSync implements DetectorSync {
  private async _asyncAttributes(): Promise<Attributes> {
    return (await detect()).attributes;
  }

  detect(): Resource {
    return new Resource({}, this._asyncAttributes());
  }
}
