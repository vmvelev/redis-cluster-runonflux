# Redis Cluster Manager for RunOnFlux

A distributed Redis management solution designed for RunOnFlux platform, providing high availability and automatic synchronization between Redis nodes.

## Overview

This project provides a distributed Redis setup with the following features:
- Multiple Redis instances for high availability
- Automatic node discovery
- Data synchronization between nodes
- REST API for data operations
- Timestamp-based conflict resolution
- Distributed locking mechanism
- Automatic failover handling

## Architecture

The system consists of three main components:

1. **Redis Component** (Data Storage)
   - Multiple Redis instances running in parallel
   - Persistent storage with appendonly enabled
   - Password authentication

2. **Redis Cluster Manager** (Orchestration Layer)
   - Manages connections to all Redis nodes
   - Handles data synchronization
   - Provides REST API for operations
   - Multiple instances for high availability

3. **Your Application** (Client Layer)
   - Connects to the cluster manager via REST API
   - Uses API key authentication
   - Can be any application that needs Redis storage

## Setup on RunOnFlux

### 1. Redis Component

```plaintext
Name: redis
Repository: bitnami/redis:latest
Container Ports: [6379]
Domains: [""]
Environment Variables:
  - REDIS_PASSWORD=yourPasswordHere
```

### 2. Cluster Manager Component

```plaintext
Name: clusterManager
Repository: vmvelev/redis-cluster-manager:latest
Container Ports: [3000]
Domains: [""]
Environment Variables:
  - APP_NAME=theNameOfYourApp
  - REDIS_PORT=autoAssignedRedisPort
  - API_KEY=yourSecretApiKey
  - REDIS_PASSWORD=yourPasswordFromRedis
```

### 3. Your Application Component

```plaintext
Name: yourAppName
Repository: your-image:tag
Container Ports: [your-port]
Domains: [your-domains]
Environment Variables:
  - API_KEY=sameKeyAsClusterManager
```

## Example Configuration

Here's a complete example setup:

```plaintext
App name: myAwesomeApp

Component #1 (Redis):
- Name: redis
- Repository: bitnami/redis:latest
- Ports: [31309]
- Container Ports: [6379]
- Environment: ["REDIS_PASSWORD=mySuperSecretPassword"]

Component #2 (Cluster Manager):
- Name: clusterManager
- Repository: vmvelev/redis-cluster-manager:latest
- Ports: [35270]
- Container Ports: [3000]
- Environment: [
    "APP_NAME=myAwesomeApp",
    "REDIS_PORT=31309",
    "API_KEY=mySecretApiKey",
    "REDIS_PASSWORD=mySuperSecretPassword"
  ]

Component #3 (Your App):
- Name: myAwesomeComponent
- Repository: vmvelev/my-awesome-component:latest
- Ports: [35333]
- Container Ports: [3333]
- Environment: ["API_KEY=mySecretApiKey"]
```

## API Usage

### Writing Data

```bash
curl -X POST http://[host]:[flux-port]/data \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"key": "myKey", "value": "myValue"}'
```

Response:
```json
{
  "success": true,
  "writtenTo": 3,
  "totalNodes": 3,
  "results": [
    {"nodeIp": "1.2.3.4", "success": true},
    {"nodeIp": "2.3.4.5", "success": true},
    {"nodeIp": "3.4.5.6", "success": true}
  ]
}
```

### Reading Data

```bash
curl http://[host]:[flux-port]/data/myKey \
  -H "x-api-key: your-api-key"
```

Response:
```json
{
  "value": "myValue",
  "timestamp": 1704243600000
}
```

## How It Works

1. **Node Discovery**
   - The cluster manager periodically discovers Redis nodes through Flux API
   - New nodes are automatically added to the connection pool
   - Failed nodes are automatically removed

2. **Data Writing**
   - Data is written to all available Redis nodes
   - Each write includes a timestamp
   - Configurable write timeout
   - Returns success status for each node

3. **Data Reading**
   - Reads from all available nodes
   - Returns the value with the latest timestamp
   - Handles node failures gracefully

4. **Node Synchronization**
   - New nodes are automatically synchronized
   - Uses distributed locking to prevent concurrent syncs
   - Batch processing for efficient data transfer
   - Automatic retry on failure

## Important Notes

1. **Port Management**
   - All ports are auto-assigned by Flux
   - Use the assigned ports in your configuration
   - The cluster manager automatically handles port discovery

2. **Configuration Matching**
   - APP_NAME must match across components
   - API_KEY must match between your app and cluster manager
   - REDIS_PASSWORD must match between Redis and cluster manager

3. **Multiple Instances**
   - Multiple instances of Redis and cluster manager will be created
   - Load balancing is handled automatically
   - Data consistency is maintained across instances

4. **Security**
   - Use strong passwords for Redis
   - Use secure API keys
   - Keep sensitive information in environment variables

## Troubleshooting

1. **Connection Issues**
   - Verify ports are correctly configured
   - Check API key and Redis password
   - Ensure all components are running

2. **Data Synchronization**
   - Check cluster manager logs for sync status
   - Verify Redis connectivity
   - Check for lock conflicts

3. **Performance**
   - Monitor write timeouts
   - Check node discovery interval
   - Adjust batch size for synchronization

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Donations

If I helped you somehow, feel free to buy me a beer by donating FLUX to `t1P2GfcmF9HBEFTuoCGNNqXKuPgCjEjCHFw`
