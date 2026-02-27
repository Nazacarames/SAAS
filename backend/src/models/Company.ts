import {
    Table,
    Column,
    CreatedAt,
    UpdatedAt,
    Model,
    PrimaryKey,
    AutoIncrement,
    AllowNull,
    Default,
    HasMany
} from "sequelize-typescript";
import User from "./User";
import Whatsapp from "./Whatsapp";
import Contact from "./Contact";
import Ticket from "./Ticket";
import Queue from "./Queue";

@Table({ tableName: "companies" })
class Company extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column
    id: number;

    @AllowNull(false)
    @Column
    name: string;

    @Column
    email: string;

    @Column
    phone: string;

    @Default(true)
    @Column
    status: boolean;

    @CreatedAt
    createdAt: Date;

    @UpdatedAt
    updatedAt: Date;

    @HasMany(() => User)
    users: User[];

    @HasMany(() => Whatsapp)
    whatsapps: Whatsapp[];

    @HasMany(() => Contact)
    contacts: Contact[];

    @HasMany(() => Ticket)
    tickets: Ticket[];

    @HasMany(() => Queue)
    queues: Queue[];
}

export default Company;
