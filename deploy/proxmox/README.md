# Running AUDA in a dedicated Proxmox VM

AUDA is designed to live in its own VM: the VM is AUDA's computer, its
workspace survives reboots, and the whole thing can be snapshotted and backed
up like any other guest.

## 1. Create the VM (on the Proxmox host)

```bash
# Ubuntu 24.04 cloud image → template (once)
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
qm create 9000 --name ubuntu-noble --memory 4096 --cores 2 --net0 virtio,bridge=vmbr0
qm importdisk 9000 noble-server-cloudimg-amd64.img local-lvm
qm set 9000 --scsihw virtio-scsi-pci --scsi0 local-lvm:vm-9000-disk-0 --ide2 local-lvm:cloudinit --boot c --bootdisk scsi0 --serial0 socket --vga serial0
qm template 9000

# AUDA VM
qm clone 9000 410 --name auda --full
qm resize 410 scsi0 +30G
qm set 410 --cicustom "user=local:snippets/auda-cloud-init.yaml" --ipconfig0 ip=dhcp
cp deploy/proxmox/cloud-init.yaml /var/lib/vz/snippets/auda-cloud-init.yaml
qm start 410
```

## 2. What cloud-init does

`cloud-init.yaml` installs Docker, clones AUDA, and starts it with
`docker compose`. Data lives in the `auda-data` volume inside the VM.

## 3. Backups and recovery

* `vzdump 410 --mode snapshot` backs up everything — database, workspace, browser profile, secrets.
* Restoring the VM restores AUDA's responsibilities, memory and unfinished tasks; it resumes on boot.
* Keep `AUDA_MASTER_KEY` somewhere safe (outside the VM) if you set one; without it, stored credentials can't be decrypted on a fresh install.

## 4. Network

Put AUDA behind your reverse proxy with TLS, set `AUDA_PUBLIC_URL` and
`AUDA_TOKEN`, and expose `/hooks/*` only if you use inbound webhooks.
